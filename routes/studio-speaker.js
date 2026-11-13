"use strict";
// PUBLIC, link-gated: a speaker's own page (migration 043, public/my-films.html).
// The person whose email a clearance card names as the one who approves (the
// speaker themself, or a minor's parent or guardian) sees every film they or
// their child are in, and can take their consent back themselves.
//
//   POST /api/studio-speaker/send-link  { email }   a link by email, if a card names it (the answer is the same either way)
//   POST /api/studio-speaker/view       { token }   the page
//   POST /api/studio-speaker/pull       { token, person_code, confirm: true, note }   take consent back
//   POST /api/studio-speaker/sign-out   { token }   stop the link
//
// The link carries the token in its fragment, and the page posts it: it never
// appears in a URL a server logs. The server sends the database the token's
// hash (the proof); the table keeps the proof's hash. Nothing about anyone
// else on a film is returned, and nothing that identifies a person goes to
// the logs. Staff send a link from a card: POST /api/studio-films/films/:id/people/:pid/page-link.

const express = require("express");
const { getSupabase } = require("../utils/supabase");
const { staffEmails } = require("../utils/staff");
const push = require("../utils/push");
const mailer = require("../utils/mailer");
const H = require("../utils/pylon-http");
const U = require("../utils/studio-films");
const SP = require("../utils/studio-speaker");
const W = require("../utils/studio-words");
const worker = require("../utils/studio-review-worker");

const router = express.Router();
const safe = H.safe("studio-speaker");
// Guessing at links: 30 tries per visitor per 10 minutes (the 256-bit token
// is what stops a guess); per connection, a flood breaker.
const perVisitor = H.windowLimiter(30, 10 * 60 * 1000);
const perPeer = H.windowLimiter(5000, 10 * 60 * 1000);
// Asking for a link: 5 per visitor an hour, 3 per email a day.
const askVisitor = H.windowLimiter(5, 60 * 60 * 1000);
const askEmail = H.windowLimiter(3, 24 * 60 * 60 * 1000);
const wellFormed = (t) => typeof t === "string" && /^[0-9a-f]{64}$/.test(t);

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "post_only" });
  if (!req.is("application/json")) return res.status(415).json({ error: "json_only" });
  if (!H.originOk(req)) return res.status(403).json({ error: "wrong_origin" });
  if (perVisitor(H.visitorKey(H.visitor(req))) || perPeer(H.peer(req))) return res.status(429).json({ error: "too_many" });
  next();
});

// The email a live link is for, or null.
async function emailFor(sb, token) {
  if (!wellFormed(token)) return null;
  const { data, error } = await sb.rpc("studio_speaker_email", { p_proof: U.sha256(token) });
  if (error) throw Object.assign(new Error(error.message), { db: error });
  const v = Array.isArray(data) ? data[0] : data;
  return typeof v === "string" ? v : v && typeof v === "object" ? Object.values(v)[0] || null : null;
}

router.post("/send-link", safe(async (req, res) => {
  const email = U.email(H.bodyOf(req).email);
  if (!email) return res.status(400).json({ error: "email" });
  if (askVisitor(H.visitorKey(H.visitor(req))) || askEmail(email)) return res.status(429).json({ error: "too_many" });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  // The same answer, at once, whether or not a card names the email: the
  // page never tells a stranger who's on a card, not even by how long it
  // takes. The look-up and the email happen after the answer.
  res.json({ ok: true });
  try {
    const { data: cards, error } = await sb.from("studio_film_people").select("reviewer_relation").eq("reviewer_email", email).not("cleared_at", "is", null).limit(50);
    if (error || !cards || !cards.length) return;
    const out = await SP.issueLink(sb, mailer, { email, sentBy: "self", relations: [...new Set(cards.map((c) => c.reviewer_relation))] });
    if (!out.sent) console.warn("[studio-speaker] a page link wasn't sent:", out.why);
  } catch (e) {
    console.warn("[studio-speaker] a page link wasn't sent:", e && e.message);
  }
}));

router.post("/view", safe(async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  let email;
  try {
    email = await emailFor(sb, H.bodyOf(req).token);
  } catch (e) {
    return res.status(503).json({ error: "storage_unavailable" });
  }
  if (!email) return res.status(404).json({ error: "link_not_active" });
  try {
    res.json(await SP.viewFor(sb, email));
  } catch (e) {
    console.error("[studio-speaker] page failed:", e && e.message);
    res.status(503).json({ error: "storage_unavailable" });
  }
}));

router.post("/pull", safe(async (req, res) => {
  const body = H.bodyOf(req);
  if (!wellFormed(body.token)) return res.status(404).json({ error: "link_not_active" });
  const code = U.code(body.person_code);
  if (!code) return res.status(400).json({ error: "person_code" });
  if (body.confirm !== true) return res.status(400).json({ error: "confirm_first" });
  const typed = U.cleanNotes(body.note, 500) || null;
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  // The link and the person first: nothing below answers anyone else.
  let email;
  try {
    email = await emailFor(sb, body.token);
  } catch (e) {
    return res.status(503).json({ error: "storage_unavailable" });
  }
  if (!email) return res.status(404).json({ error: "link_not_active" });
  const { data: cards, error: cardsError } = await sb.from("studio_film_people").select("person_code,name,reviewer_name,reviewer_relation,is_minor,reviewer_email,cleared_at").eq("person_code", code);
  if (cardsError) return res.status(503).json({ error: "storage_unavailable" });
  if (!(cards || []).some((c) => c.cleared_at && String(c.reviewer_email || "").toLowerCase() === email)) return res.status(403).json({ error: "not_yours" });
  // A note is kept with the takedown, with any name on their cards written as
  // the code: nothing is refused for a name, so the page can't be used to
  // check one.
  const note = typed ? W.maskNames(typed, cards).replace(/\s+/g, " ").trim().slice(0, 500) || null : null;
  const { data, error } = await sb.rpc("studio_speaker_pull", { p_proof: U.sha256(body.token), p_person_code: code, p_note: note });
  if (error) {
    const msg = String(error.message || "");
    if (/not active/.test(msg)) return res.status(404).json({ error: "link_not_active" });
    if (/not on a card/.test(msg)) return res.status(403).json({ error: "not_yours" });
    if (/already taken back/.test(msg)) return res.status(409).json({ error: "already_taken_back" });
    // Someone else approves for some of their films (the athlete for
    // themself, now an adult, say): the team takes it from here.
    if (/another person approves/.test(msg)) {
      res.status(409).json({ error: "ask_the_team" });
      push.notifySoon(push.teamEmails("approver"), { title: "Asked to take consent back", body: `Someone who approves for ${code} asked on their page to take consent back. Another person approves for some of the films: call them both.`, url: "/app/#films", tag: `pull-ask-${code}` });
      mailer.sendMail({
        to: [...staffEmails()],
        subject: `Asked to take consent back: ${code}`,
        text: `Someone a card names as the one who approves for ${code} asked on their own Same Work page to take consent back. Another person approves for some of ${code}'s films (the athlete themself, now an adult, or another parent), so nothing was taken back yet.\n\nCall them both today, then take it back from the card if that's what they want.${note ? `\n\nTheir note: ${note}` : ""}\n`,
        critical: true,
        pool: "studio_review",
      }).catch(() => {});
      return;
    }
    if (error.code === "P0001") return res.status(409).json({ error: "refused", reason: msg.slice(0, 300) });
    console.error("[studio-speaker] pull failed:", error.code || "");
    return res.status(503).json({ error: "storage_unavailable" });
  }
  const first = Array.isArray(data) ? data[0] : data;
  const id = first && (first.takedown_id || (typeof first === "string" ? first : null));
  if (!id) return res.status(409).json({ error: "already_taken_back" });
  const { data: td } = await sb.from("studio_takedowns").select("due_at").eq("id", id).maybeSingle();
  console.log(`[studio-speaker] consent taken back on the speaker's page: takedown ${id}`);
  res.json({ ok: true, due_at: td ? td.due_at : null });
  // Their films' review copies leave storage now (the database listed them
  // in the same change; what fails, the worker retries), and staff hear at
  // once: the 72-hour clock is running.
  worker.sweep({ sb }).catch(() => {});
  const staff = [...staffEmails()];
  push.notifySoon(push.teamEmails("approver"), { title: "Consent taken back", body: `${code} took their consent back on their own page. The 72-hour takedown clock started.`, url: "/app/#film-takedowns", tag: `takedown-${id}` });
  mailer.sendMail({
    to: staff,
    subject: `Consent taken back: ${code}`,
    text: `${code} took their consent back on their own Same Work page. Every film with them is stopped, and everything posted has to come down within 72 hours.\n\nOpen the takedowns: ${(process.env.APP_BASE || "https://tojcampaign.com").replace(/\/+$/, "")}/app/#film-takedowns\n`,
    critical: true,
    pool: "studio_review",
  }).catch(() => {});
}));

router.post("/sign-out", safe(async (req, res) => {
  const token = H.bodyOf(req).token;
  if (!wellFormed(token)) return res.json({ ok: true });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  // Said only once the link is stopped (or was already): if the database
  // couldn't be reached, the page says so and the link still works.
  const { error } = await sb.rpc("studio_speaker_sign_out", { p_proof: U.sha256(token) });
  if (error) return res.status(503).json({ error: "storage_unavailable" });
  res.json({ ok: true });
}));

router.use((req, res) => res.status(404).json({ error: "not_found" }));

module.exports = router;
module.exports._reset = () => {
  [perVisitor, perPeer, askVisitor, askEmail].forEach((l) => l.reset());
};
