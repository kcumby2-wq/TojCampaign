"use strict";
// The marketplace's footage work, done by ffmpeg in a child process: what a
// file is, the watermarked preview families see before they buy, its poster,
// and the clean frames the AI reads jersey numbers from. Originals are never
// changed. Used by utils/sm-market-worker.js.
//
// ffmpeg is FFMPEG_PATH, else the ffmpeg-static package (an optional
// dependency, so a failed download never breaks a deploy), else ffmpeg on the
// PATH. Previews and posters carry no metadata (a phone's location stays out).

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const WATERMARK = path.join(__dirname, "..", "assets", "sm-market-watermark.png");
const CLIP_SECONDS = 90; // a clip's preview covers its first 90 seconds
const SHORT_SIDE = 480; // clip previews and every poster: 480 on the short side
const PHOTO_LONG = 960; // photo previews: 960 on the long side
const FRAME_LONG = 1280; // the frames the AI reads
const MS = 1000;

class MediaError extends Error {}

function ffmpegPath(env = process.env) {
  if (env.FFMPEG_PATH) return env.FFMPEG_PATH;
  try {
    const p = require("ffmpeg-static");
    if (typeof p === "string" && fs.existsSync(p)) return p;
  } catch (e) {
    // not installed: fall back to the PATH
  }
  return "ffmpeg";
}

// Runs ffmpeg. Resolves { code, stderr } with the last 16 KB of what it said;
// a run past timeoutMs is killed.
function run(args, { bin = ffmpegPath(), timeoutMs = 10 * 60 * MS } = {}) {
  return new Promise((resolve) => {
    let stderr = "";
    let settled = false;
    const done = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stderr });
    };
    let child;
    try {
      child = spawn(bin, ["-hide_banner", "-nostdin", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      resolve({ code: -1, stderr: String(e.message) });
      return;
    }
    const timer = setTimeout(() => {
      stderr += "\n(timed out)";
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stderr.on("data", (d) => {
      stderr = (stderr + d).slice(-16384);
    });
    child.on("error", (e) => {
      stderr += "\n" + e.message;
      done(-1);
    });
    child.on("close", (code) => done(code === null ? -1 : code));
  });
}

// The last thing ffmpeg said, without the temp folder's path, for the error
// staff see on a failed file.
function lastWords(stderr, dir) {
  const lines = String(stderr || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let s = lines.length ? lines[lines.length - 1] : "ffmpeg stopped";
  if (dir) s = s.split(dir).join("");
  return s.slice(0, 200);
}

async function must(args, what, opts = {}) {
  const r = await run(args, opts);
  if (r.code !== 0) throw new MediaError(`${what}: ${lastWords(r.stderr, opts.dir)}`);
  return r;
}

// What ffmpeg says about a file: its length, the first video stream's size,
// and any turn a player applies (phones record sideways and say so).
function parseProbe(stderr) {
  const s = String(stderr || "");
  const d = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(s);
  const duration_ms = d ? Math.round((Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])) * MS) : null;
  const v = /Stream #[^\n]*?Video: [^\n]*?, (\d{1,5})x(\d{1,5})(?=[\s,[]|$)/.exec(s);
  let width = v ? Number(v[1]) : null;
  let height = v ? Number(v[2]) : null;
  const r = /rotation of (-?\d+(?:\.\d+)?) degrees/.exec(s) || /\brotate\s*:\s*(-?\d+)/.exec(s);
  const turn = r ? Math.abs(Math.round(Number(r[1]))) % 180 : 0;
  if (turn === 90 && width && height) [width, height] = [height, width];
  return { duration_ms, width, height };
}

async function probe(file, opts = {}) {
  // With no output, ffmpeg describes the input and exits 1; that's expected.
  const r = await run(["-i", file], opts);
  const info = parseProbe(r.stderr);
  if (!info.width || !info.height) throw new MediaError("Not a video or photo ffmpeg can read: " + lastWords(r.stderr, opts.dir));
  return info;
}

// A JPEG's EXIF turn isn't in what ffmpeg prints, though ffmpeg applies it.
// The preview shows the turn that was applied: the original is the other way
// round if the two disagree.
function displaySize(original, preview) {
  if (!original.width || !preview.width) return { width: original.width, height: original.height };
  const wide = (x) => x.width > x.height;
  if (original.width !== original.height && preview.width !== preview.height && wide(original) !== wide(preview)) {
    return { width: original.height, height: original.width };
  }
  return { width: original.width, height: original.height };
}

// Fit to a box, never bigger than the original.
const box = (n, fit) => `scale='min(${n},iw)':'min(${n},ih)':force_original_aspect_ratio=${fit}:force_divisible_by=2,setsar=1`;
const shortSide = (n) => box(n, "increase");
const longSide = (n) => box(n, "decrease");
const marked = (scale, fmt) => `[0:v:0]${scale}[b];[b][1:v]overlay=(W-w)/2:(H-h)/2,format=${fmt}[v]`;
// Where a still is taken from a clip: the middle of what the preview covers.
const middle = (info) => (info.duration_ms ? Math.min(info.duration_ms, CLIP_SECONDS * MS) / 2 / MS : 0);
const secs = (t) => Math.max(0, t).toFixed(3);

// The watermarked preview: a clip at 480p, H.264, silent, at most 30 frames a
// second and 90 seconds; a photo at 960 on the long side.
async function preview(src, kind, out, opts = {}) {
  if (kind === "clip") {
    return must(
      ["-i", src, "-i", WATERMARK, "-filter_complex", marked(shortSide(SHORT_SIDE), "yuv420p"), "-map", "[v]",
        "-an", "-sn", "-dn", "-map_metadata", "-1", "-t", String(CLIP_SECONDS), "-fpsmax", "30",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-threads", "2", "-movflags", "+faststart", "-y", out],
      "preview",
      opts
    );
  }
  return must(["-i", src, "-i", WATERMARK, "-filter_complex", marked(longSide(PHOTO_LONG), "yuvj420p"), "-map", "[v]", "-frames:v", "1", "-map_metadata", "-1", "-q:v", "4", "-y", out], "preview", opts);
}

// The poster: one watermarked still, 480 on the short side.
async function poster(src, kind, out, info, opts = {}) {
  const seek = kind === "clip" ? ["-ss", secs(middle(info))] : [];
  return must([...seek, "-i", src, "-i", WATERMARK, "-filter_complex", marked(shortSide(SHORT_SIDE), "yuvj420p"), "-map", "[v]", "-frames:v", "1", "-map_metadata", "-1", "-q:v", "4", "-y", out], "poster", opts);
}

// Clean frames for the AI: three across a clip (a fifth, half and four fifths
// of the way through what the preview covers), or the photo itself. Never
// stored; the worker deletes them with the rest of its temp folder.
async function frames(src, kind, dir, info, opts = {}) {
  const span = info.duration_ms ? Math.min(info.duration_ms, CLIP_SECONDS * MS) / MS : 0;
  const at = kind === "clip" && span > 0.5 ? [0.2, 0.5, 0.8].map((f) => span * f) : [0];
  const files = [];
  for (let i = 0; i < at.length; i++) {
    const file = path.join(dir, `frame-${i + 1}.jpg`);
    const seek = kind === "clip" ? ["-ss", secs(at[i])] : [];
    const r = await run([...seek, "-i", src, "-frames:v", "1", "-vf", longSide(FRAME_LONG), "-pix_fmt", "yuvj420p", "-q:v", "3", "-y", file], opts);
    if (r.code === 0 && fs.existsSync(file) && fs.statSync(file).size > 0) files.push(file);
  }
  return files;
}

module.exports = {
  MediaError,
  WATERMARK,
  CLIP_SECONDS,
  ffmpegPath,
  run,
  lastWords,
  parseProbe,
  probe,
  displaySize,
  preview,
  poster,
  frames,
};
