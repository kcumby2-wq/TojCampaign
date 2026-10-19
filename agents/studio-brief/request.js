// Brief requests — check what the browser sent (idea, links, photos, video
// stills, file text) and turn it into the task text, the reference list and
// the image blocks for the model.
//
// Privacy: photos and stills are sent to the model for this run only. They are
// never written to the database or logs; the stored task keeps the idea, the
// captions, the links and file excerpts. File names never leave the browser
// (a file name can carry a child's name), so references are "Image 1",
// "Video 1", "Link 1", "File 1".

"use strict";

const LIMITS = {
  idea: 4000,
  caption: 300,
  links: 10,
  images: 24, // photos + video stills
  photos: 12,
  videos: 4,
  framesPerVideo: 8,
  imageChars: 1600000, // base64 characters per image
  totalImageChars: 4500000, // under the server's 5 MB JSON limit
  files: 3,
  fileChars: 60000,
  totalFileChars: 120000,
};
const MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

function bad(error, extra = {}) {
  return { ok: false, error, ...extra };
}

function clean(s, max) {
  return String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, max);
}

function mmss(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function parseBriefRequest(body = {}) {
  const idea = String(body.idea || "").trim();
  if (idea.length < 10) return bad("missing_idea");
  if (idea.length > LIMITS.idea) return bad("idea_too_long", { max: LIMITS.idea });

  const t = body.target || {};
  const mode = ["refresh", "build", "either"].includes(t.mode) ? t.mode : "either";
  const slug = t.slug ? String(t.slug).trim() : null;
  if (slug && !/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) return bad("invalid_slug");

  const refs = [];
  const attachments = [];
  const files = [];

  // Links
  const links = Array.isArray(body.links) ? body.links : [];
  if (links.length > LIMITS.links) return bad("too_many_links", { max: LIMITS.links });
  links.forEach((l, i) => {
    const url = String((l && l.url) || "").trim();
    refs.push({ ref: `Link ${i + 1}`, kind: "link", url, caption: clean(l && l.caption, LIMITS.caption) });
  });
  for (const r of refs) {
    let ok = false;
    try {
      const u = new URL(r.url);
      ok = (u.protocol === "https:" || u.protocol === "http:") && !!u.hostname && r.url.length <= 2000;
    } catch {}
    if (!ok) return bad("invalid_link", { ref: r.ref });
  }

  // Photos and video stills
  const images = Array.isArray(body.images) ? body.images : [];
  if (images.length > LIMITS.images) return bad("too_many_images", { max: LIMITS.images });
  let total = 0;
  let photoN = 0;
  const videos = new Map(); // group -> { ref, frames: [] }
  for (const img of images) {
    const media_type = String((img && img.media_type) || "");
    const data = String((img && img.data) || "");
    if (!MEDIA_TYPES.has(media_type)) return bad("unsupported_image_type", { media_type });
    if (!data || data.length > LIMITS.imageChars || !B64.test(data)) return bad("bad_image_data");
    total += data.length;
    if (total > LIMITS.totalImageChars) return bad("images_too_large", { max_chars: LIMITS.totalImageChars });
    const caption = clean(img.caption, LIMITS.caption);
    if (img.video) {
      const g = Number(img.video.group);
      if (!Number.isInteger(g) || g < 1 || g > LIMITS.videos) return bad("bad_video_group");
      if (!videos.has(g)) {
        videos.set(g, { ref: `Video ${videos.size + 1}`, kind: "video", caption, duration: Number(img.video.duration) || 0, frames: [] });
      }
      const v = videos.get(g);
      if (v.frames.length >= LIMITS.framesPerVideo) return bad("too_many_frames", { max: LIMITS.framesPerVideo });
      v.frames.push({ media_type, data, at: Number(img.video.at) || 0 });
    } else {
      photoN++;
      if (photoN > LIMITS.photos) return bad("too_many_photos", { max: LIMITS.photos });
      const ref = `Image ${photoN}`;
      refs.push({ ref, kind: "image", caption });
      attachments.push({ type: "text", text: `${ref}${caption ? ` — Kyron's note: "${caption}"` : ""}` });
      attachments.push({ type: "image", source: { type: "base64", media_type, data } });
    }
  }
  for (const v of videos.values()) {
    v.frames.sort((a, b) => a.at - b.at);
    refs.push({ ref: v.ref, kind: "video", caption: v.caption, duration: v.duration, stills: v.frames.map((f) => f.at) });
    v.frames.forEach((f, i) => {
      attachments.push({
        type: "text",
        text: `${v.ref}, still ${i + 1} of ${v.frames.length} at ${mmss(f.at)}${i === 0 && v.caption ? ` — Kyron's note: "${v.caption}"` : ""}`,
      });
      attachments.push({ type: "image", source: { type: "base64", media_type: f.media_type, data: f.data } });
    });
  }

  // Files (text read in the browser: PDFs, .txt, .md)
  const fileIn = Array.isArray(body.files) ? body.files : [];
  if (fileIn.length > LIMITS.files) return bad("too_many_files", { max: LIMITS.files });
  let fileTotal = 0;
  fileIn.forEach((f, i) => {
    const text = String((f && f.text) || "").replace(/\r\n/g, "\n").trim().slice(0, LIMITS.fileChars);
    fileTotal += text.length;
    const ref = `File ${i + 1}`;
    refs.push({ ref, kind: "file", caption: clean(f && f.caption, LIMITS.caption), chars: text.length });
    files.push({ ref, text });
  });
  if (fileTotal > LIMITS.totalFileChars) return bad("files_too_long", { max_chars: LIMITS.totalFileChars });

  return { ok: true, idea, target: { mode, slug }, refs, attachments, files };
}

function describeRef(r) {
  const note = r.caption ? `: "${r.caption}"` : "";
  if (r.kind === "image") return `- ${r.ref} (photo, attached below)${note}`;
  if (r.kind === "video")
    return `- ${r.ref} (${r.stills.length} stills from a ${mmss(r.duration)} video at ${r.stills.map(mmss).join(", ")}; attached below; no sound)${note}`;
  if (r.kind === "link") return `- ${r.ref}: ${r.url}${note}`;
  return `- ${r.ref} (file text, ${r.chars.toLocaleString("en-US")} characters, below)${note}`;
}

function buildBriefTask(req, today) {
  const target =
    req.target.mode === "refresh"
      ? `Refresh the approved kit "${req.target.slug || "same-work"}".`
      : req.target.mode === "build"
        ? `Build a new kit${req.target.slug ? ` (suggested name "${req.target.slug}")` : ""}.`
        : "You decide: refresh an approved kit or build a new one.";
  const lines = [
    `Today: ${today}.`,
    `What it's for: ${target}`,
    "",
    "Kyron's idea:",
    req.idea,
    "",
    `References (${req.refs.length}):`,
    ...(req.refs.length ? req.refs.map(describeRef) : ["(none)"]),
  ];
  for (const f of req.files) lines.push("", `<file ref="${f.ref}">`, f.text, "</file>");
  return lines.join("\n");
}

module.exports = { LIMITS, parseBriefRequest, buildBriefTask, mmss };
