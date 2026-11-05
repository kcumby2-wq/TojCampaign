"use strict";
// The marketplace's processing queue. Each uploaded clip or photo gets a
// watermarked preview, a poster and the AI's jersey suggestions, then waits
// in review for a person to confirm who's in it:
//
//   uploaded → processing → review        (failed after 3 tries; staff retry)
//
// It runs inside the web server, one file at a time. A file is claimed by
// moving it from uploaded to processing in one update, so two servers never
// take the same one. A file left in processing (a restart mid-way) goes back
// in the queue after 30 minutes. The AI is optional: with no key, or if it
// fails, the file still reaches review, just without suggestions.
//
//   SM_MARKET_WORKER=off   don't run it here
//   MARKET_TAG_MODEL       the model that reads jersey numbers (default claude-haiku-5-5)
//   ANTHROPIC_API_KEY      without it, no suggestions

const os = require("os");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const M = require("./sm-market");
const media = require("./sm-market-media");
const { getSupabase } = require("./supabase");

const MAX_ATTEMPTS = 3;
const STALE_MS = 30 * 60 * 1000;
const BATCH = 20; // files per pass, before giving the server a breather
const tagModel = () => process.env.MARKET_TAG_MODEL || "claude-haiku-5-5";

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

// ── The AI's suggestions ─────────────────────────────────────────────────
async function suggestWithClaude({ prompt, images }) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const SDK = require("@anthropic-ai/sdk");
  const Anthropic = SDK.default || SDK;
  const client = new Anthropic({ timeout: 60 * 1000, maxRetries: 1 });
  const msg = await client.messages.create({
    model: tagModel(),
    max_tokens: 600,
    messages: [
      {
        role: "user",
        content: [
          ...images.map((data) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } })),
          { type: "text", text: prompt },
        ],
      },
    ],
  });
  return (msg.content || []).filter((b) => b && b.type === "text").map((b) => b.text).join("\n");
}

// ── Storage ──────────────────────────────────────────────────────────────
async function download(d, key, file) {
  const { data, error } = await d.sb.storage.from(M.BUCKET).createSignedUrl(key, 15 * 60);
  if (error || !data || !data.signedUrl) throw new media.MediaError("The original isn't in storage.");
  const res = await d.fetch(data.signedUrl);
  if (!res.ok || !res.body) throw new media.MediaError(`Download failed (${res.status}).`);
  const size = Number(res.headers && res.headers.get && res.headers.get("content-length"));
  if (size > M.MAX_UPLOAD_BYTES) throw new media.MediaError("The original is bigger than 2 GB.");
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
}

async function upload(d, key, file, contentType) {
  const { error } = await d.sb.storage.from(M.BUCKET).upload(key, await fs.promises.readFile(file), { contentType, upsert: true, cacheControl: "3600" });
  if (error) throw new Error(`Saving ${path.basename(key)} failed: ${error.message || "storage error"}`);
}

// ── One file ─────────────────────────────────────────────────────────────
async function suggestions(row, frames, d) {
  if (!frames.length || !d.suggest) return [];
  const [event, teams, roster] = await Promise.all([
    q(d.sb.from("sm_market_events").select("id,name,sport").eq("id", row.event_id).maybeSingle()),
    q(d.sb.from("sm_market_teams").select("id,name").eq("event_id", row.event_id)),
    q(d.sb.from("sm_market_athletes").select("id,team_id,jersey").eq("event_id", row.event_id)),
  ]);
  if (!event || !(roster || []).length) return [];
  const images = [];
  for (const f of frames) images.push((await fs.promises.readFile(f)).toString("base64"));
  const answer = await d.suggest({ prompt: M.tagPrompt(event, teams || [], roster), images });
  return answer ? M.parseTagAnswer(answer, teams || [], roster) : [];
}

async function processOne(row, d) {
  const dir = await fs.promises.mkdtemp(path.join(d.tmp, "sm-market-"));
  const opts = { dir };
  const keys = [];
  try {
    const ext = (/\.([a-z0-9]+)$/.exec(row.object_key) || [, "bin"])[1];
    const src = path.join(dir, "original." + ext);
    await download(d, row.object_key, src);
    const info = await d.media.probe(src, opts);
    const isClip = row.kind === "clip";
    // What the database can hold, said plainly before any work is done.
    if (isClip && info.duration_ms > 3600 * 1000) throw new media.MediaError("Longer than an hour. Cut it into clips, then upload those.", { final: true });
    if (info.width > 20000 || info.height > 20000) throw new media.MediaError("Bigger than 20,000 pixels on a side.", { final: true });
    const out = path.join(dir, isClip ? "preview.mp4" : "preview.jpg");
    const still = path.join(dir, "poster.jpg");
    await d.media.preview(src, row.kind, out, opts);
    await d.media.poster(src, row.kind, still, info, opts);
    const shown = d.media.displaySize(info, await d.media.probe(out, opts));
    const previewKey = M.previewKey(row.event_id, row.id, row.kind);
    const posterKey = M.posterKey(row.event_id, row.id);
    await upload(d, previewKey, out, isClip ? "video/mp4" : "image/jpeg");
    keys.push(previewKey);
    await upload(d, posterKey, still, "image/jpeg");
    keys.push(posterKey);

    // Suggestions are a help, never a reason to fail the file.
    let found = [];
    try {
      found = await suggestions(row, await d.media.frames(src, row.kind, dir, info, opts), d);
    } catch (e) {
      console.warn("[sm-market] jersey suggestions skipped:", e && e.message);
    }
    for (const s of found) {
      const { error } = await d.sb.from("sm_market_tags").insert({ media_id: row.id, athlete_id: s.athlete_id, event_id: row.event_id, source: "ai", confidence: s.confidence, confirmed: false });
      if (error && error.code !== "23505") console.warn("[sm-market] suggestion not saved:", error.message);
    }

    const at = d.now().toISOString();
    const { data: done, error } = await d.sb
      .from("sm_market_media")
      .update({
        status: "review",
        preview_key: previewKey,
        poster_key: posterKey,
        duration_ms: isClip ? info.duration_ms : null,
        width: shown.width,
        height: shown.height,
        error: null,
        processed_at: at,
        updated_at: at,
      })
      .eq("id", row.id)
      .eq("status", "processing")
      .select("id");
    if (error) {
      // A value the database won't take is this file's problem, not the queue's.
      if (/^2[23]/.test(String(error.code || ""))) throw new media.MediaError("Its details didn't fit: " + String(error.message || "").slice(0, 160), { final: true });
      throw new DbError(error);
    }
    // Deleted (or retried) while it was being worked on: don't leave its files behind.
    if (!(done || []).length) await d.sb.storage.from(M.BUCKET).remove(keys).catch(() => {});
    return { ok: true, suggestions: found.length };
  } catch (e) {
    // A file that didn't make it to review leaves no previews behind.
    if (keys.length) await d.sb.storage.from(M.BUCKET).remove(keys).catch(() => {});
    throw e;
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function failOne(row, e, d) {
  const last = row.attempts >= MAX_ATTEMPTS || !!(e && e.final);
  const why = e instanceof media.MediaError ? e.message : "Processing stopped: " + String((e && e.message) || "unknown error");
  const at = d.now().toISOString();
  await d.sb
    .from("sm_market_media")
    .update({ status: last ? "failed" : "uploaded", error: why.slice(0, 300), updated_at: at })
    .eq("id", row.id)
    .eq("status", "processing");
  return { ok: false, failed: last, error: why };
}

// ── The queue ────────────────────────────────────────────────────────────
// Files a restart left in processing go back in the queue (or fail, on
// their third try).
async function recover(d) {
  const before = new Date(d.now().getTime() - STALE_MS).toISOString();
  const stuck = await q(d.sb.from("sm_market_media").select("id,attempts").eq("status", "processing").lt("processing_at", before).limit(50));
  for (const r of stuck || []) {
    const last = r.attempts >= MAX_ATTEMPTS;
    await d.sb
      .from("sm_market_media")
      .update(last ? { status: "failed", error: "Processing stopped partway three times.", updated_at: d.now().toISOString() } : { status: "uploaded", updated_at: d.now().toISOString() })
      .eq("id", r.id)
      .eq("status", "processing");
  }
  return (stuck || []).length;
}

// The oldest waiting file, moved to processing in one update. If another
// server moved it first, the update matches nothing and the next is tried.
// A file that just failed waits for the next pass (skip), not a second go now.
async function claim(d, skip = new Set()) {
  const waiting = await q(d.sb.from("sm_market_media").select("id,attempts").eq("status", "uploaded").order("created_at", { ascending: true }).limit(5 + skip.size));
  for (const w of waiting || []) {
    if (skip.has(w.id)) continue;
    const at = d.now().toISOString();
    const got = await q(
      d.sb
        .from("sm_market_media")
        .update({ status: "processing", processing_at: at, attempts: Math.min(10, (w.attempts || 0) + 1), updated_at: at })
        .eq("id", w.id)
        .eq("status", "uploaded")
        .select("*")
    );
    if (got && got.length) return got[0];
  }
  return null;
}

function defaults(over = {}) {
  return { sb: getSupabase(), media, suggest: suggestWithClaude, fetch: (...a) => globalThis.fetch(...a), tmp: os.tmpdir(), now: () => new Date(), ...over };
}

// One pass: put stuck files back, then work through the queue.
async function drain(over = {}) {
  const d = defaults(over);
  if (!d.sb) return { processed: 0 };
  await recover(d);
  let processed = 0;
  const results = [];
  const tried = new Set();
  for (let i = 0; i < BATCH; i++) {
    const row = await claim(d, tried);
    if (!row) break;
    tried.add(row.id);
    processed++;
    try {
      results.push({ id: row.id, ...(await processOne(row, d)) });
    } catch (e) {
      if (e instanceof DbError) throw e;
      console.warn(`[sm-market] ${row.id} attempt ${row.attempts}:`, e && e.message);
      results.push({ id: row.id, ...(await failOne(row, e, d)) });
    }
  }
  return { processed, results };
}

// ── Running it ───────────────────────────────────────────────────────────
let timer = null;
let running = false;
let again = false;
let quiet = false;
let lastRun = Promise.resolve();

function kick() {
  if (!timer) return lastRun; // not started here (tests, or SM_MARKET_WORKER=off)
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
        if (!quiet) console.warn("[sm-market] the marketplace tables aren't set up yet (migration 033); the worker waits.");
        quiet = true;
      } else console.error("[sm-market] worker pass failed:", e && e.message);
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
  if (process.env.SM_MARKET_WORKER === "off" || timer) return false;
  timer = setInterval(kick, intervalMs);
  timer.unref();
  setTimeout(kick, 5000).unref();
  return true;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { MAX_ATTEMPTS, STALE_MS, start, stop, kick, drain, claim, recover, processOne, suggestWithClaude, tagModel };
