"use strict";
// The Studio taste library (migration 041, docs/studio-films.md): notes on
// work worth learning from (a film, a cut, a look, a sound, a graphic, a
// caption), each with a link to it and what to take and leave. Never a photo
// or a copy of the work: a link to an image file is refused. Briefs cite an
// entry as "Taste 12" (agents/studio-brief/taste.js). Team members with
// Studio, signed in:
//
//   GET  /api/studio-taste?q=&tag=&limit=     search (words in any form, a tag), newest first without words
//   GET  /api/studio-taste/tags               the tags in use, most used first
//   GET  /api/studio-taste/:id                one note (archived ones too), to edit it
//   POST /api/studio-taste                    { title, url, kind, note, take, leave, tags }
//   PATCH /api/studio-taste/:id               the same fields, with the updated_at you saw (whoever added it, or the producer)
//   POST /api/studio-taste/:id/archive        { archived } (whoever added it, or the producer)

const express = require("express");
const { getSupabase } = require("../utils/supabase");
const T = require("../utils/team");
const H = require("../utils/pylon-http");
const U = require("../utils/studio-films");
const K = require("../agents/studio/kit");

const router = express.Router();
const safe = H.safe("studio-taste");
const member = T.requireTeam("studio", "member");
const me = (req) => req.team.email;
const isProducer = (req) => T.can(req.team, "studio", "approver");
const bodyOf = H.bodyOf;
const KINDS = ["film", "cut", "look", "sound", "graphic", "caption", "other"];
// A link to a picture or a video file, as far as its address shows (the
// database checks the same: migration 041's studio_taste_file_link): the
// file's ending in any case, with a trailing "/" or ";v=2", "%2E" for the
// dot; an image service's own address; format=jpg in the query. A link that
// redirects to one can't be told.
const FILE_END = /\.(jpe?g|jpe|jfif|pjpeg|pjp|png|apng|gif|webp|heic|heif|avif|bmp|dib|tiff?|svgz?|ico|jxl|jp2|j2k|dng|cr2|nef|arw|raw|psd|mp4|m4v|mov|webm|mkv|avi|wmv|flv|mpe?g|3gp|ts|m3u8)$/;
const IMAGE_QUERY = /(^|&)(format|fm|ext|type|mime)=(jpe?g|png|gif|webp|avif|heic|svg|bmp|image%2f[a-z]+|image\/[a-z]+)(&|$)/;
const IMAGE_HOST = /(^|\.)(pbs\.twimg\.com|images\.unsplash\.com|plus\.unsplash\.com|i\.imgur\.com|i\.redd\.it|preview\.redd\.it|lh[0-9]\.googleusercontent\.com|media\.licdn\.com|scontent[a-z0-9.-]*\.fbcdn\.net|scontent[a-z0-9.-]*\.cdninstagram\.com|i\.pinimg\.com|images\.squarespace-cdn\.com|cdn\.shopify\.com|i\.ytimg\.com|img\.youtube\.com|i\.vimeocdn\.com|media\.giphy\.com|i\.giphy\.com|images\.pexels\.com|cdn\.pixabay\.com|live\.staticflickr\.com|farm[0-9]+\.staticflickr\.com|upload\.wikimedia\.org|video\.twimg\.com|v[0-9]+\.cdninstagram\.com)$/;
function fileLink(url) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return true;
  }
  let path = u.pathname.toLowerCase().replace(/%2e/g, ".").replace(/%2f/g, "/");
  path = path.replace(/;[^/]*/g, "").replace(/\/+$/, "");
  // Instagram's /p/<id>/media/ address sends the picture itself.
  const media = /(^|\.)instagram\.com$/.test(u.hostname.toLowerCase()) && /^\/(p|reel|tv)\/[^/]+\/media$/.test(path);
  return FILE_END.test(path) || media || IMAGE_QUERY.test(u.search.replace(/^\?/, "").toLowerCase()) || IMAGE_HOST.test(u.hostname.toLowerCase());
}

router.use((req, res, next) => {
  if (["POST", "PATCH", "DELETE"].includes(req.method) && !req.is("application/json")) return res.status(415).json({ error: "json_only" });
  if (["POST", "PATCH", "DELETE"].includes(req.method) && !H.originOk(req)) return res.status(403).json({ error: "wrong_origin" });
  res.set("Cache-Control", "private, no-store");
  next();
});

function withDb(fn) {
  return safe(async (req, res) => {
    const sb = getSupabase();
    if (!sb) return res.status(503).json({ error: "storage_unavailable" });
    return fn(req, res, sb);
  });
}
function refused(res, error) {
  if (error && error.code === "P0001") return res.status(409).json({ error: "refused", reason: String(error.message || "").slice(0, 300) });
  if (error && /^(23|22)/.test(String(error.code || ""))) return res.status(400).json({ error: "invalid" });
  console.error("[studio-taste] storage error:", error && error.message);
  return res.status(503).json({ error: "storage_unavailable" });
}

// What a taste note is: checked here, and by the database.
function tasteInput(raw, { partial = false } = {}) {
  const r = raw && typeof raw === "object" ? raw : {};
  const errors = [];
  const v = {};
  const want = (k) => !partial || Object.prototype.hasOwnProperty.call(r, k);
  if (want("title")) {
    v.title = U.clean(r.title, 120);
    if (!v.title) errors.push("title");
  }
  if (want("url")) {
    v.url = U.https(r.url);
    if (!v.url || v.url.length > 500) errors.push("url");
    // A link to the work, never a copy of a picture or a video file of it.
    else if (fileLink(v.url)) errors.push("url_is_an_image");
  }
  if (want("kind")) {
    v.kind = KINDS.includes(r.kind) ? r.kind : "film";
  }
  if (want("note")) {
    v.note = U.clean(r.note, 1000);
    if (!v.note) errors.push("note");
  }
  if (want("take")) v.take = U.clean(r.take, 500) || null;
  if (want("leave")) v.leave = U.clean(r.leave, 500) || null;
  if (want("tags")) {
    const tags = (Array.isArray(r.tags) ? r.tags : String(r.tags || "").split(","))
      .map((t) => String(t || "").toLowerCase().replace(/[^a-z0-9 -]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 24))
      .filter((t) => /^[a-z0-9]/.test(t));
    v.tags = [...new Set(tags)].slice(0, 8);
  }
  const words = [v.title, v.note, v.take, v.leave, ...(v.tags || [])].filter(Boolean).join("\n");
  if (K.lintWords(words, "x").length) errors.push("banned_words");
  return { errors, value: v };
}
// Every film reads the taste library: a name on any film's cards (a whole
// name, one run together, any word of a minor's) is refused, as the
// database refuses it (studio_names_in_any).
async function namesInTaste(sb, value) {
  const words = [value.title, value.note, value.take, value.leave, ...(value.tags || [])].filter(Boolean).join("\n");
  if (!words) return false;
  const { data } = await sb.from("studio_film_people").select("name,reviewer_name,is_minor").limit(10000);
  const cards = data || [];
  return U.namesIn(words, cards, { strong: true }).length > 0 || U.minorWords(words, cards).length > 0;
}
const view = (row) => ({ id: row.id, ref: `Taste ${row.ref_no}`, ref_no: row.ref_no, title: row.title, url: row.url, kind: row.kind, note: row.note, take: row.take, leave: row.leave, tags: row.tags || [], added_by: row.added_by, created_at: row.created_at, updated_at: row.updated_at, archived_at: row.archived_at });

router.get("/", member, withDb(async (req, res, sb) => {
  const q = U.clean(req.query.q, 200) || null;
  const tag = req.query.tag ? String(req.query.tag).toLowerCase().trim().slice(0, 24) : null;
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 30));
  const { data, error } = await sb.rpc("studio_taste_search", { p_q: q, p_tag: tag, p_limit: limit });
  if (error) return refused(res, error);
  res.json({ entries: (Array.isArray(data) ? data : []).map(view), can: { producer: isProducer(req) }, me: me(req) });
}));

router.get("/tags", member, withDb(async (req, res, sb) => {
  const { data, error } = await sb.from("studio_taste").select("tags").is("archived_at", null).limit(5000);
  if (error) return refused(res, error);
  const n = new Map();
  for (const r of data || []) for (const t of r.tags || []) n.set(t, (n.get(t) || 0) + 1);
  res.json({ tags: [...n.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)).slice(0, 60) });
}));

router.get("/:id", member, withDb(async (req, res, sb) => {
  if (!U.UUID.test(String(req.params.id || ""))) return res.status(404).json({ error: "not_found" });
  const { data: row, error } = await sb.from("studio_taste").select("*").eq("id", req.params.id).maybeSingle();
  if (error) return refused(res, error);
  if (!row) return res.status(404).json({ error: "not_found" });
  res.json({ entry: view(row), can: { edit: row.added_by === me(req) || isProducer(req) } });
}));

router.post("/", member, withDb(async (req, res, sb) => {
  const { errors, value } = tasteInput(bodyOf(req));
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });
  if (await namesInTaste(sb, value)) return res.status(400).json({ error: "invalid", fields: ["taste_has_name"] });
  const { data, error } = await sb.from("studio_taste").insert({ ...value, added_by: me(req) }).select().single();
  if (error) return refused(res, error);
  await T.logActivity(me(req), "studio_taste_added", `Taste ${data.ref_no}`, null);
  res.json({ entry: view(data) });
}));

async function mine(sb, req, res) {
  const { data: row, error } = await sb.from("studio_taste").select("*").eq("id", String(req.params.id || "")).maybeSingle();
  if (error && !/^22/.test(String(error.code || ""))) { refused(res, error); return null; }
  if (!row) { res.status(404).json({ error: "not_found" }); return null; }
  if (row.added_by !== me(req) && !isProducer(req)) { res.status(403).json({ error: "producer_only" }); return null; }
  return row;
}

router.patch("/:id", member, withDb(async (req, res, sb) => {
  if (!U.UUID.test(String(req.params.id || ""))) return res.status(404).json({ error: "not_found" });
  const row = await mine(sb, req, res);
  if (!row) return;
  const body = bodyOf(req);
  if (typeof body.seen !== "string") return res.status(400).json({ error: "invalid", fields: ["seen"] });
  const { errors, value } = tasteInput(body, { partial: true });
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });
  if (!Object.keys(value).length) return res.json({ entry: view(row) });
  if (await namesInTaste(sb, { ...row, ...value })) return res.status(400).json({ error: "invalid", fields: ["taste_has_name"] });
  const { data, error } = await sb.from("studio_taste").update(value).eq("id", row.id).eq("updated_at", body.seen).select();
  if (error) return refused(res, error);
  if (!data || !data.length) return res.status(409).json({ error: "changed_meanwhile" });
  res.json({ entry: view(data[0]) });
}));

router.post("/:id/archive", member, withDb(async (req, res, sb) => {
  if (!U.UUID.test(String(req.params.id || ""))) return res.status(404).json({ error: "not_found" });
  const row = await mine(sb, req, res);
  if (!row) return;
  const archived = bodyOf(req).archived === true;
  const { data, error } = await sb.from("studio_taste").update(archived ? { archived_at: new Date().toISOString(), archived_by: me(req) } : { archived_at: null, archived_by: null }).eq("id", row.id).select();
  if (error) return refused(res, error);
  res.json({ entry: view(data[0]) });
}));

router.use((req, res) => res.status(404).json({ error: "not_found" }));

router._tasteInput = tasteInput;
router._fileLink = fileLink;
module.exports = router;
