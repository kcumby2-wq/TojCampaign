"use strict";
// A speaker's own page (migration 043, routes/studio-speaker.js,
// public/my-films.html): the link, its email, and what the page shows.
//
// What the page shows is only about the people whose cards name that email
// as the one who approves: the speaker themself, or a minor's parent or
// guardian. Never anyone else on a film, never a title (titles carry the
// athlete ID, and a film can have more than one person), never a name.

const crypto = require("crypto");
const U = require("./studio-films");
const F = require("../agents/studio/films");
const TP = require("../public/app/transcript-parse.js");

const env = (k) => String(process.env[k] || "").trim();
const SITE_BASE = () => (env("STUDIO_SITE_BASE") || "https://www.tojcampaign.com").replace(/\/+$/, "");

// A new token for an email: the page link carries it, the database keeps the
// hash of its hash.
function newToken() {
  const token = crypto.randomBytes(32).toString("hex");
  return { token, proof: U.sha256(token), link: `${SITE_BASE()}/my-films.html#t=${token}` };
}

function pageEmail({ relations = [], link }) {
  const forChild = relations.some((r) => r !== "self");
  const forSelf = relations.includes("self");
  const who = forSelf && forChild ? "you and your child" : forChild ? "your child" : "you";
  return {
    subject: "Your Same Work page",
    text:
      "Hi,\n\n" +
      `Here's your own page for the Same Work films ${who === "your child" ? "your child is" : who + " are"} in: where each one is, what you've approved, what's posted, and the words that were kept.\n\n` +
      `${link}\n\n` +
      "You can take your consent back there at any time. If you do, every film stops and everything posted comes down within 72 hours.\n\n" +
      "The link works for 7 days. Please don't forward it: anyone with it sees your page and can take your consent back.\n\n" +
      "If you didn't ask for this, you can ignore it.\n\n" +
      "Same Work",
  };
}

// Make a link for an email and send it. Once the email is accepted, the new
// link stops the older ones (studio_speaker_supersede): an ask that can't be
// sent leaves the person's working link as it was. No email, no link: one
// that couldn't be sent is stopped at once. Replies
// go back to the person (or an address nobody reads), never to staff: a
// reply quotes the link. Returns { sent } or { sent: false, why }.
async function issueLink(sb, mailer, { email, sentBy, relations }) {
  const { proof, link } = newToken();
  const { error } = await sb.from("studio_speaker_links").insert({ email, proof_hash: U.sha256(proof), sent_by: sentBy });
  if (error) return { sent: false, why: "storage" };
  const m = pageEmail({ relations, link });
  let sent = null;
  try {
    sent = await mailer.sendMail({ to: email, subject: m.subject, text: m.text, replyTo: U.email(env("STUDIO_REVIEW_REPLY_TO")) || email, pool: "studio_review" });
  } catch (e) {
    console.warn("[studio-speaker] page link email failed:", mailer.errorCode ? mailer.errorCode(e) : "error");
  }
  if (!sent || !sent.sent) {
    await sb.rpc("studio_speaker_sign_out", { p_proof: proof }).then(() => {}, () => {});
    return { sent: false, why: sent && sent.reason === "email_not_configured" ? "email_not_set_up" : "email" };
  }
  await sb.rpc("studio_speaker_supersede", { p_proof: proof }).then(() => {}, () => {});
  return { sent: true };
}

const STATE = { pulled: "Stopped: consent taken back", archived: "Put away", published: "Done", active: "Being made" };

// What the page shows for an email. Posts are only of cuts the person is in
// (the clip log), and the words are only their own, as they said them, with
// where in the recording: never a caption written around them.
async function viewFor(sb, email) {
  const q = async (query) => {
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return data || [];
  };
  // Only cards the producer cleared: an email on an unchecked card isn't
  // known to be theirs yet.
  const cards = await q(sb.from("studio_film_people").select("id,film_id,person_code,role,is_minor,reviewer_relation,cleared_at,consent_pulled_at,covers").eq("reviewer_email", email).not("cleared_at", "is", null));
  if (!cards.length) return { people: [] };
  const filmIds = [...new Set(cards.map((c) => c.film_id))];
  const cardIds = cards.map((c) => c.id);
  const codes = [...new Set(cards.map((c) => c.person_code))];
  const now = new Date().toISOString();
  const [films, steps, cuts, reviews, waiting, posts, takedowns, transcripts] = await Promise.all([
    q(sb.from("studio_films").select("id,kit_slug,format,lane,post_date,pulled_at,archived_at").in("id", filmIds)),
    q(sb.from("studio_film_steps").select("film_id,step,status").in("film_id", filmIds)),
    q(sb.from("studio_film_cuts").select("id,film_id,format,ratio,version,people").in("film_id", filmIds)),
    // Only this approver's own decisions (a card's approver can change).
    q(sb.from("studio_reviews").select("cut_id,person_id,decision,decided_at,withdrawn_at").in("person_id", cardIds).eq("reviewer_email", email).not("decided_at", "is", null)),
    q(sb.from("studio_reviews").select("person_id,expires_at").in("person_id", cardIds).is("decided_at", null).not("link_hash", "is", null).gt("expires_at", now)),
    q(sb.from("studio_film_posts").select("film_id,cut_id,platform,url,posted_at,removed_at").in("film_id", filmIds)),
    q(sb.from("studio_takedowns").select("person_code,requested_at,due_at,source,closed_at").in("person_code", codes)),
    q(sb.from("studio_transcripts").select("id,person_id").in("person_id", cardIds)).catch(() => []),
  ]);
  const words = transcripts.length
    ? await q(sb.from("studio_words").select("kind,quote,start_ms,transcript_id,film_id").in("transcript_id", transcripts.map((t) => t.id)).in("kind", ["line", "beat", "caption"])).catch(() => [])
    : [];
  const cutOf = (id) => cuts.find((x) => x.id === id) || null;
  const cutLabel = (id) => {
    const c = cutOf(id);
    return c ? `${c.format.replace(/_/g, " ")} ${String(c.ratio).replace("x", ":")} v${c.version}` : "a cut";
  };
  const fmtLabel = (f) => {
    const t = F.templateFor(f.kit_slug);
    return t && t.formats[f.format] ? t.formats[f.format].label : String(f.format).replace(/_/g, " ");
  };
  const stateOf = (f) => {
    if (f.pulled_at) return "pulled";
    if (f.archived_at) return "archived";
    return steps.some((s) => s.film_id === f.id && s.status === "todo") ? "active" : "published";
  };
  const ownWords = (c, f) => {
    if (c.is_minor) return [];
    const mine = new Set(transcripts.filter((t) => t.person_id === c.id).map((t) => t.id));
    const seen = new Set();
    return words
      .filter((w) => w.film_id === f.id && mine.has(w.transcript_id) && w.quote)
      .sort((a, b) => (a.start_ms || 0) - (b.start_ms || 0))
      .filter((w) => {
        const k = `${w.transcript_id}|${w.start_ms}|${w.quote}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, 40)
      .map((w) => ({ quote: w.quote, at: TP.tc(w.start_ms) }));
  };
  const people = codes.map((code) => {
    const mine = cards.filter((c) => c.person_code === code);
    const td = takedowns.filter((t) => t.person_code === code).sort((a, b) => String(b.requested_at).localeCompare(String(a.requested_at)))[0] || null;
    return {
      code,
      relation: mine[0].reviewer_relation,
      is_minor: mine.some((c) => c.is_minor),
      // Taken back on every card (no film with them goes on), or still live on
      // some: after a new consent, the old takedown is history and the page
      // offers to take the new one back.
      pulled: mine.every((c) => c.consent_pulled_at),
      live: mine.some((c) => !c.consent_pulled_at),
      takedown: td ? { requested_at: td.requested_at, due_at: td.due_at, by_speaker: td.source === "speaker", closed: !!td.closed_at } : null,
      films: mine
        .map((c) => {
          const f = films.find((x) => x.id === c.film_id);
          if (!f) return null;
          const st = stateOf(f);
          return {
            format: fmtLabel(f),
            lane: f.lane,
            state: st,
            state_label: STATE[st],
            post_date: f.post_date || null,
            cleared: !!c.cleared_at && !c.consent_pulled_at,
            covers: { face: (c.covers || {}).face === true, name: (c.covers || {}).name === true, jersey: (c.covers || {}).jersey === true, voice: (c.covers || {}).voice === true },
            waiting_for_you: !c.consent_pulled_at && waiting.some((r) => r.person_id === c.id),
            approvals: reviews
              .filter((r) => r.person_id === c.id)
              .sort((a, b) => String(a.decided_at).localeCompare(String(b.decided_at)))
              .map((r) => ({ cut: cutLabel(r.cut_id), decision: r.decision, decided_at: r.decided_at, withdrawn: !!r.withdrawn_at })),
            posts: posts
              .filter((p) => p.film_id === f.id && ((cutOf(p.cut_id) || {}).people || []).includes(c.id))
              .map((p) => ({ platform: p.platform, url: p.removed_at ? null : p.url, posted_at: p.posted_at, removed: !!p.removed_at, cut: cutLabel(p.cut_id) })),
            words: ownWords(c, f),
          };
        })
        .filter(Boolean),
    };
  });
  return { people };
}

module.exports = { newToken, pageEmail, issueLink, viewFor };
