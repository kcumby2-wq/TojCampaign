"use strict";
// Studio review copies (migration 039). An editor uploads a cut for review;
// this makes the copy its speakers watch: the cut at 720 on the short side,
// with its sound, "REVIEW COPY · NOT FOR SHARING" burned in, and a poster. It
// also takes the uploaded file's sha256, the fingerprint every approval is
// tied to:
//
//   uploaded → processing → ready        (failed after 3 tries)
//
// It runs inside the web server, one cut at a time, claimed by moving it from
// uploaded to processing in one update. A cut left in processing (a restart
// mid-way) goes back in the queue after 30 minutes. Nothing leaves the
// server but the files it writes back to the private bucket.
//
//   STUDIO_REVIEW_WORKER=off   don't run it here

const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const media = require("./sm-market-media");
const U = require("./studio-films");
const { getSupabase } = require("./supabase");

const MAX_ATTEMPTS = 3;
const STALE_MS = 30 * 60 * 1000;
const MAX_SECONDS = 10 * 60; // a review copy is at most 10 minutes (a sit-down is 3 to 5)
const SHORT_SIDE = 720;
const WATERMARK = path.join(__dirname, "..", "assets", "studio-review-watermark.png");

const notSetUp = (e) => !!e && (e.code === "42P01" || e.code === "PGRST205" || /does not exist|schema cache/i.test(String(e.message || "")));
class DbError extends Error {
  constructor(error) {
    super(error && error.message ? error.message : "storage_error");
    this.db = error;
  }
}
async function q(query) {
  const { data, error } = await query;
  if (error) throw new DbError(error);
  return data;
}

async function download(d, key, file) {
  const { data, error } = await d.sb.storage.from(U.BUCKET).createSignedUrl(key, 15 * 60);
  if (error || !data || !data.signedUrl) throw new media.MediaError("The uploaded cut isn't in storage.");
  const r = await d.fetch(data.signedUrl);
  if (!r.ok || !r.body) throw new Error(`storage answered ${r.status}`);
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(file));
}

async function upload(d, key, file, contentType) {
  const { error } = await d.sb.storage.from(U.BUCKET).upload(key, await fs.promises.readFile(file), { contentType, upsert: true, cacheControl: "3600" });
  if (error) throw new Error("storage refused " + key + ": " + error.message);
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file).on("error", reject).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest("hex")));
  });
}

const box = `scale='min(${SHORT_SIDE},iw)':'min(${SHORT_SIDE},ih)':force_original_aspect_ratio=increase:force_divisible_by=2,setsar=1`;
const marked = (fmt) => `[0:v:0]${box}[b];[b][1:v]overlay=(W-w)/2:(H-h)/2,format=${fmt}[v]`;

// The copy the speaker watches: with its sound (they're approving their own
// words), no metadata (a phone's location stays out).
async function reviewCopy(d, src, out, opts) {
  return d.media.run(
    ["-i", src, "-i", WATERMARK, "-filter_complex", marked("yuv420p"), "-map", "[v]", "-map", "0:a:0?",
      "-c:a", "aac", "-b:a", "128k", "-sn", "-dn", "-map_metadata", "-1", "-t", String(MAX_SECONDS), "-fpsmax", "30",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-threads", "2", "-movflags", "+faststart", "-y", out],
    opts
  ).then((r) => {
    if (r.code !== 0 || !fs.existsSync(out) || fs.statSync(out).size === 0) throw new media.MediaError("Couldn't make the review copy: " + media.lastWords(r.stderr, opts.dir));
    return r;
  });
}

async function posterOf(d, src, out, info, opts) {
  const at = info.duration_ms ? Math.max(0, info.duration_ms / 2000).toFixed(3) : "0";
  const r = await d.media.run(["-ss", at, "-i", src, "-i", WATERMARK, "-filter_complex", marked("yuvj420p"), "-map", "[v]", "-frames:v", "1", "-map_metadata", "-1", "-q:v", "4", "-y", out], opts);
  if (r.code !== 0 || !fs.existsSync(out)) throw new media.MediaError("Couldn't make the poster: " + media.lastWords(r.stderr, opts.dir));
}

async function processOne(row, d) {
  const dir = await fs.promises.mkdtemp(path.join(d.tmp, "studio-cut-"));
  try {
    const src = path.join(dir, "cut." + (/\.(mp4|mov|m4v)$/.exec(row.object_key) || [, "mp4"])[1]);
    await download(d, row.object_key, src);
    const bytes = (await fs.promises.stat(src)).size;
    const sha = await sha256File(src);
    const info = await d.media.probe(src, { dir });
    if (!info.duration_ms) throw new media.MediaError("That isn't a video with a length ffmpeg can read.", { final: true });
    if (info.duration_ms > MAX_SECONDS * 1000) throw new media.MediaError("A review copy is at most 10 minutes. Upload the cut you want approved.", { final: true });
    const out = path.join(dir, "review.mp4");
    const pic = path.join(dir, "poster.jpg");
    await reviewCopy(d, src, out, { dir });
    await posterOf(d, src, pic, info, { dir });
    const pk = U.previewKey(row.film_id, row.id);
    const ok = U.posterKey(row.film_id, row.id);
    await upload(d, pk, out, "video/mp4");
    await upload(d, ok, pic, "image/jpeg");
    const done = await q(
      d.sb
        .from("studio_film_cuts")
        .update({ status: "ready", sha256: sha, bytes, duration_ms: info.duration_ms, width: info.width, height: info.height, preview_key: pk, poster_key: ok, error: null, updated_at: d.now().toISOString() })
        .eq("id", row.id)
        .eq("status", "processing")
        .select("id")
    );
    return { ok: !!(done && done.length), sha256: sha };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function failOne(row, e, d) {
  const last = row.attempts >= MAX_ATTEMPTS || !!(e && e.final);
  const why = e instanceof media.MediaError ? e.message : "Processing stopped: " + String((e && e.message) || "unknown error");
  await d.sb
    .from("studio_film_cuts")
    .update({ status: last ? "failed" : "uploaded", error: why.slice(0, 300), updated_at: d.now().toISOString() })
    .eq("id", row.id)
    .eq("status", "processing");
  return { ok: false, failed: last, error: why };
}

async function recover(d) {
  const before = new Date(d.now().getTime() - STALE_MS).toISOString();
  const stuck = await q(d.sb.from("studio_film_cuts").select("id,attempts").eq("status", "processing").lt("claimed_at", before).limit(50));
  for (const r of stuck || []) {
    const last = r.attempts >= MAX_ATTEMPTS;
    await d.sb
      .from("studio_film_cuts")
      .update(last ? { status: "failed", error: "Processing stopped partway three times.", updated_at: d.now().toISOString() } : { status: "uploaded", updated_at: d.now().toISOString() })
      .eq("id", r.id)
      .eq("status", "processing");
  }
  return (stuck || []).length;
}

async function claim(d, skip = new Set()) {
  const waiting = await q(d.sb.from("studio_film_cuts").select("id,attempts").eq("status", "uploaded").order("created_at", { ascending: true }).limit(5 + skip.size));
  for (const w of waiting || []) {
    if (skip.has(w.id)) continue;
    const at = d.now().toISOString();
    const got = await q(
      d.sb
        .from("studio_film_cuts")
        .update({ status: "processing", claimed_at: at, attempts: Math.min(10, (w.attempts || 0) + 1), updated_at: at })
        .eq("id", w.id)
        .eq("status", "uploaded")
        .select("*")
    );
    if (got && got.length) return got[0];
  }
  return null;
}

function defaults(over = {}) {
  return { sb: getSupabase(), media, fetch: (...a) => globalThis.fetch(...a), tmp: os.tmpdir(), now: () => new Date(), ...over };
}

async function drain(over = {}) {
  const d = defaults(over);
  if (!d.sb) return { processed: 0 };
  await recover(d);
  let processed = 0;
  const results = [];
  const tried = new Set();
  for (let i = 0; i < 10; i++) {
    const row = await claim(d, tried);
    if (!row) break;
    tried.add(row.id);
    processed++;
    try {
      results.push({ id: row.id, ...(await processOne(row, d)) });
    } catch (e) {
      if (e instanceof DbError) throw e;
      console.warn(`[studio] cut ${row.id} attempt ${row.attempts}:`, e && e.message);
      results.push({ id: row.id, ...(await failOne(row, e, d)) });
    }
  }
  return { processed, results };
}

let timer = null;
let running = false;
let again = false;
let quiet = false;
let lastRun = Promise.resolve();

function kick() {
  if (!timer) return lastRun;
  if (running) {
    again = true;
    return lastRun;
  }
  running = true;
  lastRun = drain()
    .then((r) => {
      quiet = false;
      return r;
    })
    .catch((e) => {
      if (e && e.db && notSetUp(e.db)) {
        if (!quiet) console.warn("[studio] the film tables aren't set up yet (migration 039); review copies wait.");
        quiet = true;
      } else console.error("[studio] review-copy pass failed:", e && e.message);
    })
    .finally(() => {
      running = false;
      if (again) {
        again = false;
        kick();
      }
    });
  return lastRun;
}

function start({ intervalMs = 60 * 1000 } = {}) {
  if (process.env.STUDIO_REVIEW_WORKER === "off" || timer) return false;
  timer = setInterval(kick, intervalMs);
  timer.unref();
  setTimeout(kick, 7000).unref();
  return true;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { MAX_ATTEMPTS, STALE_MS, MAX_SECONDS, WATERMARK, start, stop, kick, drain, claim, recover, processOne, sha256File };
