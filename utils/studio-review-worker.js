"use strict";
// Studio review copies (migrations 039, 040). An editor uploads a cut for
// review; this makes the copy its speakers watch: the cut at 720 on the short
// side, with its sound, "REVIEW COPY · NOT FOR SHARING" burned in, and a
// poster; stills and slides get a marked copy of each image. It takes the
// uploaded files' sha256, the fingerprint every approval is tied to (the files
// that will post), and the copies' own sha256, whose start is in the copies'
// storage key, so a copy can't be swapped for another unseen:
//
//   uploaded → processing → ready        (failed after 3 tries, or the film closed)
//
// It runs inside the web server, one cut at a time, claimed by moving it from
// uploaded to processing in one update. A cut left in processing (a restart
// mid-way) goes back in the queue after 30 minutes. Nothing is made for a
// pulled or archived film, and nothing it made stays behind if the cut didn't
// make it. Each pass also retries the files the database listed for removal
// (a deleted cut's, a pulled film's). Nothing leaves the server but the files
// it writes back to the private bucket.
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
const Still = require("./studio-still");
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
// A deadlock (the producer changing the film in the same instant) is ended
// by rolling one side back: that side is tried once more.
async function q(query) {
  let { data, error } = await query;
  if (error && (error.code === "40P01" || error.code === "40001")) {
    await new Promise((r) => setTimeout(r, 30 + Math.floor(Math.random() * 70)));
    ({ data, error } = await query);
  }
  if (error) throw new DbError(error);
  return data;
}

// Files made for a cut that didn't make it: removed now, or, if storage says
// no, listed for the next pass.
async function takeBack(d, keys) {
  if (!keys.length) return;
  let ok = false;
  try {
    const { error } = await d.sb.storage.from(U.BUCKET).remove(keys);
    ok = !error;
  } catch (e) {
    ok = false;
  }
  if (!ok) {
    for (const key of keys) {
      // Listed once: a key already on the list keeps its reason (a pull's
      // stays a pull's, so it's never kept back) and is due again.
      try {
        const { error } = await d.sb.from("studio_storage_removals").insert({ key, reason: "left_over" });
        if (error && error.code === "23505") await d.sb.from("studio_storage_removals").update({ done_at: null }).eq("key", key);
      } catch (e) {
        /* the next pass finds it: the folder sweep, or the list */
      }
    }
  }
}

async function download(d, key, file) {
  const { data, error } = await d.sb.storage.from(U.BUCKET).createSignedUrl(key, 15 * 60);
  if (error || !data || !data.signedUrl) throw new media.MediaError("The uploaded cut isn't in storage.");
  const r = await d.fetch(data.signedUrl);
  if (!r.ok || !r.body) throw new Error(`storage answered ${r.status}`);
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(file));
}

// Copies are named by their content and never overwritten: an object already
// at that key is the same bytes.
async function upload(d, key, file, contentType) {
  const { error } = await d.sb.storage.from(U.BUCKET).upload(key, await fs.promises.readFile(file), { contentType, upsert: false, cacheControl: "3600" });
  if (error && !/already exists|duplicate/i.test(String(error.message || "")) && String(error.statusCode || error.status || "") !== "409") {
    throw new Error("storage refused " + key + ": " + error.message);
  }
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

// The film is still open (not pulled, not archived) and the cut still here.
async function stillWanted(d, row) {
  const f = await q(d.sb.from("studio_films").select("pulled_at,archived_at").eq("id", row.film_id).maybeSingle());
  return !!f && !f.pulled_at && !f.archived_at;
}
const closed = () => new media.MediaError("The film closed (consent pulled or archived) while its review copy was being made.", { final: true });
const refusedClosed = (e) => !!e && e.db && e.db.code === "P0001" && /closed/.test(String(e.db.message || ""));

// What a cut became, saved; or, if it didn't make it, the files made for it
// taken back out (a film that closed, a cut deleted meanwhile).
async function finish(d, row, keys, patch) {
  let done;
  try {
    done = await q(d.sb.from("studio_film_cuts").update({ ...patch, status: "ready", error: null, updated_at: d.now().toISOString() }).eq("id", row.id).eq("status", "processing").select("id"));
  } catch (e) {
    await takeBack(d, keys);
    if (refusedClosed(e)) throw closed();
    throw e;
  }
  if (!(done || []).length) await takeBack(d, keys);
  return !!(done && done.length);
}

// A still or a set of slides (a parent card, a quote card, a carousel): each
// image's copy at 1080 on the long side, marked REVIEW COPY, without its
// metadata (a phone photo's location stays out). The fingerprint speakers
// approve is of the files themselves: the sha256 of their sha256s, in order.
// The copies go in a folder named by their own fingerprint (the sha256 of the
// copies' sha256s), so none is ever overwritten.
const SLIDE_LONG_SIDE = 1080;
const slideBox = `scale='min(${SLIDE_LONG_SIDE},iw)':'min(${SLIDE_LONG_SIDE},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1`;
async function slideCopy(d, src, out, opts) {
  const r = await d.media.run(
    ["-i", src, "-i", WATERMARK, "-filter_complex", `[0:v:0]${slideBox}[b];[b][1:v]overlay=(W-w)/2:(H-h)/2,format=yuvj420p[v]`, "-map", "[v]", "-frames:v", "1", "-map_metadata", "-1", "-q:v", "3", "-y", out],
    opts
  );
  if (r.code !== 0 || !fs.existsSync(out) || fs.statSync(out).size === 0) throw new media.MediaError("Couldn't make the review copy of a slide: " + media.lastWords(r.stderr, opts.dir));
}
const setHash = (hashes) => crypto.createHash("sha256").update(hashes.join("\n"), "utf8").digest("hex");
async function graphicsOn(d) {
  const r = await q(d.sb.from("studio_tool_approvals").select("is_on").eq("tool", "graphics_system").maybeSingle());
  return !!(r && r.is_on);
}

async function processSlides(row, d) {
  const dir = await fs.promises.mkdtemp(path.join(d.tmp, "studio-slides-"));
  try {
    if (!(await stillWanted(d, row))) throw closed();
    const keys = row.slide_keys || [];
    if (!keys.length) throw new media.MediaError("The set has no slides.", { final: true });
    const hashes = [];
    const copies = [];
    let bytes = 0;
    let first = null;
    for (let i = 0; i < keys.length; i++) {
      const src = path.join(dir, `slide-${i + 1}.${/\.jpg$/.test(keys[i]) ? "jpg" : "png"}`);
      await download(d, keys[i], src);
      bytes += (await fs.promises.stat(src)).size;
      // One opaque still of a sane size (utils/studio-still.js), so the copy
      // shows what the file shows; one the graphics system made doesn't go
      // as an "upload" while that system is off.
      const still = Still.check(await fs.promises.readFile(src));
      if (!still.ok) throw new media.MediaError(`Slide ${i + 1}: ${still.why}.`, { final: true });
      if (still.marked && row.made_with !== "graphics" && !(await graphicsOn(d))) {
        throw new media.MediaError(`Slide ${i + 1} was made with the graphics system, which is off: it can't go to review as an upload.`, { final: true });
      }
      hashes.push(await sha256File(src));
      const info = await d.media.probe(src, { dir });
      if (info.duration_ms && info.duration_ms > 100) throw new media.MediaError(`Slide ${i + 1} isn't a still image.`, { final: true });
      if (!first) first = info;
      const out = path.join(dir, `copy-${i + 1}.jpg`);
      await slideCopy(d, src, out, { dir });
      copies.push({ file: out, sha: await sha256File(out) });
    }
    const sha = setHash(hashes);
    const copySha = setHash(copies.map((c) => c.sha));
    const prefix = U.slideCopyPrefix(row.film_id, row.id, copySha);
    const made = copies.map((_, i) => `${prefix}${i + 1}.jpg`);
    // Checked again just before anything is written for it.
    if (!(await stillWanted(d, row))) throw closed();
    try {
      for (let i = 0; i < copies.length; i++) await upload(d, made[i], copies[i].file, "image/jpeg");
    } catch (e) {
      await takeBack(d, made);
      throw e;
    }
    const saved = await finish(d, row, made, { sha256: sha, preview_sha256: copySha, bytes, width: first.width, height: first.height, preview_key: prefix, poster_key: made[0] });
    return { ok: saved, sha256: sha, preview_sha256: copySha };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function processOne(row, d) {
  if (row.kind === "slides") return processSlides(row, d);
  const dir = await fs.promises.mkdtemp(path.join(d.tmp, "studio-cut-"));
  try {
    if (!(await stillWanted(d, row))) throw closed();
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
    const copySha = await sha256File(out);
    const pk = U.previewKey(row.film_id, row.id, copySha);
    const ok = U.posterKey(row.film_id, row.id, copySha);
    // Checked again just before anything is written for it.
    if (!(await stillWanted(d, row))) throw closed();
    const keys = [];
    try {
      await upload(d, pk, out, "video/mp4");
      keys.push(pk);
      await upload(d, ok, pic, "image/jpeg");
      keys.push(ok);
    } catch (e) {
      await takeBack(d, [pk, ok]);
      throw e;
    }
    const saved = await finish(d, row, [pk, ok], { sha256: sha, preview_sha256: copySha, bytes, duration_ms: info.duration_ms, width: info.width, height: info.height, preview_key: pk, poster_key: ok });
    return { ok: saved, sha256: sha, preview_sha256: copySha };
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
    let got;
    try {
      got = await q(
        d.sb
          .from("studio_film_cuts")
          .update({ status: "processing", claimed_at: at, attempts: Math.min(10, (w.attempts || 0) + 1), updated_at: at })
          .eq("id", w.id)
          .eq("status", "uploaded")
          .select("*")
      );
    } catch (e) {
      // Its film closed before it was made: it's done waiting.
      if (!refusedClosed(e)) throw e;
      await d.sb.from("studio_film_cuts").update({ status: "failed", error: "The film closed (consent pulled or archived) before its review copy was made.", updated_at: at }).eq("id", w.id).eq("status", "uploaded");
      skip.add(w.id);
      continue;
    }
    if (got && got.length) return got[0];
  }
  return null;
}

// A pulled film's folder is emptied on every pass for 3 hours after the
// pull: an upload link made before it (they last 2 hours) can still land a
// file that no row lists.
const PULLED_SWEEP_MS = 3 * 60 * 60 * 1000;
// Every file under a folder, a page of 1000 at a time. A listing storage
// refuses throws: that film is looked at again on the next pass.
const LIST_PAGE = 1000;
async function listAll(d, prefix, depth = 0) {
  if (depth > 4) return [];
  const out = [];
  for (let offset = 0; offset < 100 * LIST_PAGE; offset += LIST_PAGE) {
    const { data, error } = await d.sb.storage.from(U.BUCKET).list(prefix, { limit: LIST_PAGE, offset });
    if (error) throw new Error(`listing ${prefix}: ${error.message || "storage refused"}`);
    for (const e of data || []) {
      const key = `${prefix}/${e.name}`;
      if (e.id) out.push(key);
      else out.push(...(await listAll(d, key, depth + 1)));
    }
    if (!data || data.length < LIST_PAGE) break;
  }
  return out;
}
// Every film pulled in the last 3 hours, newest pull first, a page at a
// time. A file storage won't remove goes on the removal list, so it's tried
// again after the 3 hours are up.
async function sweepPulled(d) {
  const since = new Date(d.now().getTime() - PULLED_SWEEP_MS).toISOString();
  let removed = 0;
  for (let from = 0; from < 5000; from += 200) {
    const films = (await q(d.sb.from("studio_films").select("id,pulled_at").gte("pulled_at", since).order("pulled_at", { ascending: false }).order("id", { ascending: true }).range(from, from + 199))) || [];
    for (const f of films) {
      let keys;
      try {
        keys = await listAll(d, `films/${f.id}`);
      } catch (e) {
        console.warn("[studio] pulled-film sweep couldn't list a folder; next pass tries again:", e && e.message);
        continue;
      }
      for (let i = 0; i < keys.length; i += 100) {
        const part = keys.slice(i, i + 100);
        let ok = false;
        try {
          ok = !(await d.sb.storage.from(U.BUCKET).remove(part)).error;
        } catch (e) {
          ok = false;
        }
        if (ok) removed += part.length;
        else await takeBack(d, part);
      }
    }
    if (films.length < 200) break;
  }
  return removed;
}

// The files the database listed for removal (a deleted cut's, a pulled
// film's, the worker's own leftovers): removed, and marked done; what storage
// refuses is tried again on the next pass. Then a pulled film's folder, and
// takedowns with nothing left on them closed. Returns how many were removed.
async function sweep(over = {}) {
  const d = defaults(over);
  if (!d.sb || !d.sb.storage) return { removed: 0, left: 0 };
  let swept = 0;
  try {
    swept = await sweepPulled(d);
  } catch (e) {
    console.warn("[studio] pulled-film sweep failed:", e && e.message);
  }
  try {
    await q(d.sb.rpc("studio_close_finished_takedowns", {}));
  } catch (e) {
    console.warn("[studio] closing finished takedowns failed:", e && e.message);
  }
  // Left-overs a ready cut uses are kept (studio_removals_due marks them done).
  const todo = (await q(d.sb.rpc("studio_removals_due", { p_limit: 500 }))) || [];
  if (!todo.length) return { removed: swept, left: 0 };
  const keys = todo.map((x) => x.key);
  const at = d.now().toISOString();
  let failed = null;
  try {
    const { error } = await d.sb.storage.from(U.BUCKET).remove(keys);
    if (error) failed = error.message || "storage refused";
  } catch (e) {
    failed = (e && e.message) || "storage unreachable";
  }
  if (failed) {
    for (const x of todo) await d.sb.from("studio_storage_removals").update({ tries: Math.min(1e6, (x.tries || 0) + 1), last_error: String(failed).slice(0, 300) }).eq("key", x.key).is("done_at", null);
    console.warn(`[studio] removing ${keys.length} file(s) failed; tried again next pass:`, failed);
    return { removed: swept, left: keys.length };
  }
  for (let i = 0; i < keys.length; i += 100) {
    await q(d.sb.from("studio_storage_removals").update({ done_at: at, last_error: null }).in("key", keys.slice(i, i + 100)).is("done_at", null).select("key"));
  }
  return { removed: swept + keys.length, left: 0 };
}

function defaults(over = {}) {
  return { sb: getSupabase(), media, fetch: (...a) => globalThis.fetch(...a), tmp: os.tmpdir(), now: () => new Date(), ...over };
}

async function drain(over = {}) {
  const d = defaults(over);
  if (!d.sb) return { processed: 0 };
  await sweep(over).catch((e) => console.warn("[studio] removal pass failed:", e && e.message));
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

// Files a refused registration left in storage (the routes): removed now,
// or put on the removal list if storage says no.
async function forget(keys, over = {}) {
  const d = defaults(over);
  if (!d.sb || !d.sb.storage || !keys || !keys.length) return;
  await takeBack(d, keys);
}

module.exports = { MAX_ATTEMPTS, STALE_MS, MAX_SECONDS, WATERMARK, start, stop, kick, drain, claim, recover, sweep, forget, processOne, processSlides, sha256File };
