"use strict";
// PUBLIC, link-gated: a speaker (or a minor's parent or guardian) watches the
// REVIEW COPY of a Studio film they're in and approves it or asks for a change
// (migration 039, public/film-review.html). No staff session is involved; the
// one-time link is the only key.
//
//   POST /api/studio-review/view    { token }   the review copy to watch (a link for 2 hours)
//   POST /api/studio-review/decide  { token, decision: "approved" | "changes", name, note, confirm: true }
//
// The link (from POST /api/studio-films/films/:id/cuts/:cid/reviews, by
// email) carries the token in its fragment, and the page posts it: it never
// appears in a URL a server logs. The server sends the database the token's
// hash (the proof); the table keeps the proof's hash. Links work once, for 7
// days, on a film and a card that are still open. The approval is for that
// exact file. Nothing about anyone else on the film is returned, and nothing
// that identifies a person goes to the logs.
//
// After a decision, the reviewer gets a receipt first (it's how they'd learn
// someone else used their link), then staff hear which film it was.

const express = require("express");
const { getSupabase } = require("../utils/supabase");
const { staffEmails } = require("../utils/staff");
const push = require("../utils/push");
const mailer = require("../utils/mailer");
const H = require("../utils/pylon-http");
const U = require("../utils/studio-films");
const F = require("../agents/studio/films");

const router = express.Router();
const safe = H.safe("studio-review");
const env = (k) => String(process.env[k] || "").trim();
const APP_BASE = () => (env("APP_BASE") || "https://tojcampaign.com").replace(/\/+$/, "");
// Guessing at links: 30 tries per visitor per 10 minutes (the 256-bit token
// is what stops a guess); per connection, a flood breaker that protects the
// database (through Vercel every reviewer shares one).
const perVisitor = H.windowLimiter(30, 10 * 60 * 1000);
const perPeer = H.windowLimiter(5000, 10 * 60 * 1000);
const wellFormed = (t) => typeof t === "string" && /^[0-9a-f]{64}$/.test(t);
const firstRow = (data) => (Array.isArray(data) ? data[0] || null : data && typeof data === "object" ? data : null);
function idOf(data) {
  const first = Array.isArray(data) ? data[0] : data;
  if (typeof first === "string") return U.UUID.test(first) ? first : null;
  return first && typeof first.review_id === "string" ? first.review_id : null;
}
// A name with at least two letters (any alphabet), and nothing that reads as
// a link or an address.
function decidedName(v) {
  const { personName } = require("../utils/pylon");
  const name = personName(v);
  return name && (name.match(/\p{L}/gu) || []).length >= 2 ? name : null;
}
const formatLabel = (kit, format) => {
  const t = F.templateFor(kit);
  const f = t && t.formats[format];
  return f ? f.label : "film";
};

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "post_only" });
  if (!req.is("application/json")) return res.status(415).json({ error: "json_only" });
  if (!H.originOk(req)) return res.status(403).json({ error: "wrong_origin" });
  if (perVisitor(H.visitorKey(H.visitor(req))) || perPeer(H.peer(req))) return res.status(429).json({ error: "too_many" });
  next();
});

router.post("/view", safe(async (req, res) => {
  const token = H.bodyOf(req).token;
  if (!wellFormed(token)) return res.status(400).json({ error: "bad_link" });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  const { data, error } = await sb.rpc("studio_review_for_reviewer", { p_proof: U.sha256(token) });
  if (error) return res.status(503).json({ error: "storage_unavailable" });
  const r = firstRow(data);
  if (!r || !r.review_id) return res.status(404).json({ error: "link_not_active" });
  // Watch links last two hours: long enough to watch twice, short enough
  // that a copied link dies.
  let video = null;
  let poster = null;
  const slides = [];
  try {
    // A set of slides is seen as its copies (marked REVIEW COPY): the set's
    // folder (preview_key), then 1.jpg, 2.jpg, ... never the files themselves.
    const copies = r.kind === "slides" && r.preview_key && /\/$/.test(r.preview_key) ? (r.slide_keys || []).map((_, i) => `${r.preview_key}${i + 1}.jpg`) : [];
    const keys = r.kind === "slides" ? copies : [r.preview_key, r.poster_key].filter(Boolean);
    if (keys.length) {
      const { data: signed } = await sb.storage.from(U.BUCKET).createSignedUrls(keys, 2 * 60 * 60);
      const by = new Map((signed || []).filter((x) => x && x.signedUrl).map((x) => [x.path, x.signedUrl]));
      if (r.kind === "slides") for (const k of copies) slides.push(by.get(k) || null);
      else {
        video = by.get(r.preview_key) || null;
        poster = r.poster_key ? by.get(r.poster_key) || null : null;
      }
    }
  } catch (e) {
    console.warn("[studio-review] watch link failed:", e && e.message);
  }
  if (r.kind === "slides" ? !slides.length || slides.some((x) => !x) : !video) return res.status(503).json({ error: "storage_unavailable" });
  res.json({
    ok: true,
    relation: r.relation === "self" ? "self" : r.relation === "guardian" ? "guardian" : "parent",
    reviewer_name: r.reviewer_name || null,
    kind: r.kind === "slides" ? "slides" : "video",
    format: formatLabel(r.kit_slug, r.format),
    ratio: r.ratio,
    version: r.version,
    duration_ms: r.duration_ms,
    story: r.one_sentence || null,
    video_url: video,
    poster_url: poster,
    slides,
    expires_at: r.expires_at,
  });
}));

router.post("/decide", safe(async (req, res) => {
  const body = H.bodyOf(req);
  if (!wellFormed(body.token)) return res.status(400).json({ error: "bad_link" });
  const decision = body.decision;
  if (decision !== "approved" && decision !== "changes") return res.status(400).json({ error: "bad_decision" });
  if (body.confirm !== true) return res.status(400).json({ error: "confirm_required" });
  const name = decidedName(body.name);
  if (!name) return res.status(400).json({ error: "name_required" });
  const note = U.cleanNotes(body.note, 1000);
  if (decision === "changes" && Array.from(note || "").length < 3) return res.status(400).json({ error: "say_what_to_change" });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  // One statement: the link is checked, burned and the decision recorded together.
  // A deadlock (the producer changing the film in the same instant) is ended
  // by rolling one side back: the decision is tried once more.
  const args = { p_proof: U.sha256(body.token), p_decision: decision, p_name: name, p_note: note || null };
  let { data, error } = await sb.rpc("studio_review_decide", args);
  if (error && (error.code === "40P01" || error.code === "40001")) {
    await new Promise((r) => setTimeout(r, 30 + Math.floor(Math.random() * 70)));
    ({ data, error } = await sb.rpc("studio_review_decide", args));
  }
  if (error) {
    console.error("[studio-review] decision not recorded:", error.code || "");
    return res.status(503).json({ error: "storage_unavailable" });
  }
  const id = idOf(data);
  if (!id) return res.status(404).json({ error: "link_not_active" });
  console.log(`[studio-review] review ${id} ${decision} through the reviewer's link`);
  res.json({ ok: true, decision });

  // The reviewer's receipt first, then staff. Each on its own, so one failing
  // can't stop the other. Never throws.
  setImmediate(async () => {
    let r = null;
    let film = null;
    let cut = null;
    let person = null;
    try {
      ({ data: r } = await sb.from("studio_reviews").select("id,film_id,cut_id,person_id,reviewer_email").eq("id", id).maybeSingle());
      if (r) {
        ({ data: film } = await sb.from("studio_films").select("id,kit_slug,title,athlete_id,editor_email").eq("id", r.film_id).maybeSingle());
        ({ data: cut } = await sb.from("studio_film_cuts").select("id,format,ratio,version").eq("id", r.cut_id).maybeSingle());
        ({ data: person } = await sb.from("studio_film_people").select("person_code,reviewer_name").eq("id", r.person_id).maybeSingle());
      }
    } catch (e) {
      console.warn("[studio-review] after-decision read failed:", e && e.message);
    }
    if (!r || !film || !cut) return;
    const label = formatLabel(film.kit_slug, cut.format);
    try {
      const m = U.reviewReceipt({ reviewerName: (person && person.reviewer_name) || "there", decision, formatLabel: label, decidedName: name });
      const replyTo = U.email(env("STUDIO_REVIEW_REPLY_TO")) || r.reviewer_email;
      const sent = await mailer.sendMail({ to: r.reviewer_email, subject: m.subject, text: m.text, replyTo, pool: "studio_review" });
      if (!sent.sent) console.warn(`[studio-review] receipt not sent (${sent.reason})`);
    } catch (e) {
      console.warn("[studio-review] receipt failed:", mailer.errorCode(e));
    }
    try {
      const code = person ? person.person_code : "A speaker";
      const what = decision === "approved" ? "approved" : "asked for a change to";
      const title = decision === "approved" ? `${code} approved the review copy` : `${code} asked for a change`;
      const url = `/app/#film/${film.id}`;
      // The producer hears either way; a change goes to the film's editor too.
      const who = push.teamEmails("approver").then((list) => (decision === "changes" && film.editor_email && !list.includes(film.editor_email) ? list.concat([film.editor_email]) : list));
      push.notifySoon(who, { title, body: `${label} ${cut.ratio} v${cut.version} · ${film.title}`, url, tag: `review-${r.id}` });
      const to = [...staffEmails()];
      const sent = await mailer.sendMail({
        to,
        subject: title,
        text: `${code} ${what} the ${label.toLowerCase()} (${cut.ratio} v${cut.version}) of "${film.title}".\n\nOpen the film: ${APP_BASE()}${url}\n`,
        pool: "studio_review",
      });
      if (!sent.sent) console.warn(`[studio-review] staff email not sent (${sent.reason})`);
    } catch (e) {
      console.warn("[studio-review] staff alert failed:", mailer.errorCode(e));
    }
  });
}));

router.use((req, res) => res.status(404).json({ error: "not_found" }));

module.exports = router;
module.exports._reset = () => {
  perVisitor.reset();
  perPeer.reset();
};
