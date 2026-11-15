"use strict";
// Film templates: how a kit's films run (routes/studio-films.js). A kit is the
// playbook; a template turns its "Handoffs and checklists" column into the
// ten steps a film goes through, with each step's owner, what the handoff
// carries and when it's done, in the kit's own words. The checklists
// themselves are read from the approved kit at the time (by card title), so a
// kit refresh updates every film's checklist.
//
// The database (migration 039) holds the order and the hard lines; this file
// is the wording and who does what.

// The ten steps every film has, in order (migration 039 creates them).
const STEP_KEYS = Object.freeze(["brief", "board", "clearance", "shoot", "selects", "rough_cut", "speaker_review", "rights_check", "final_signoff", "publish"]);

// Who does a step: the producer (an approver or the owner), the film's
// director or editor (or the producer), or the owner alone.
const OWNERS = Object.freeze(["producer", "director", "editor", "owner"]);

const SAME_WORK = Object.freeze({
  kit_slug: "same-work",
  name: "Same Work",
  file_prefix: "SW",
  second_yes_label: "Coach Hooks",
  // The kit's file names carry the lane: its example is YTH (youth). The other
  // codes follow the same shape and are the app's until the kit names them.
  lanes: Object.freeze({
    nfl: { label: "NFL", code: "NFL" },
    college: { label: "College", code: "COL" },
    youth: { label: "Youth", code: "YTH" },
    parent: { label: "Parent", code: "PAR" },
  }),
  // The formats column: lengths in seconds, ratios as the kit lists them. The
  // kit's example file name uses HERO; the other codes are the app's.
  formats: Object.freeze({
    hero: { label: "Hero film", code: "HERO", ratios: ["9x16", "4x5"], seconds: [60, 90], spec: "60–90 seconds · 9:16, plus a 4:5 feed cut" },
    cutdown: { label: "Cutdown", code: "CUT", ratios: ["9x16"], seconds: [15, 30], spec: "15–30 seconds · three per hero film · 9:16" },
    sit_down: { label: "Parent Sit-Down", code: "SIT", ratios: ["9x16"], seconds: [60, 300], spec: "3–5 minutes, plus a 60–90 second cut · 9:16" },
    parent_card: { label: "Parent card", code: "PCARD", ratios: ["4x5"], still: true, spec: "One still · 4:5" },
    quote_card: { label: "Quote card", code: "QUOTE", ratios: ["4x5", "9x16"], seconds: [5, 7], still: true, spec: "A still, or 5–7 seconds · 4:5 and 9:16" },
    same_drill: { label: "Same Drill", code: "DRILL", ratios: ["9x16"], seconds: [10, 20], spec: "10–20 seconds · 9:16" },
    own_words: { label: "In Their Own Words", code: "WORDS", ratios: ["4x5"], slides: [5, 7], spec: "A carousel of 5–7 slides · 4:5" },
    on_the_mic: { label: "On the Mic", code: "MIC", ratios: ["9x16"], seconds: [45, 75], spec: "45–75 seconds · 9:16" },
  }),
  steps: Object.freeze([
    { key: "brief", label: "Brief", owner: "producer", carries: "The lane, the athlete ID, the format, a draft one-sentence story and the post date.", done_when: "The director can say the story back in one sentence." },
    { key: "board", label: "Board", owner: "director", carries: "The board link, the shoot date, locations and the question list.", done_when: "The producer can fill the clearance card." },
    { key: "clearance", label: "Clearance card", owner: "producer", carries: "For everyone on camera: the release on file, what it covers, the face call, the parent contact.", done_when: "No card, no shoot." },
    { key: "shoot", label: "Shoot", owner: "director", carries: "A parent or guardian on set the whole time a minor is there.", done_when: "Cards copied twice to the producer's storage, folders named by athlete ID.", checklist: "Shoot day: director" },
    { key: "selects", label: "Selects", owner: "director", carries: "Selects, a marked transcript, the archive log with rights notes, the frame pair.", done_when: "The editor can cut without calling the director." },
    { key: "rough_cut", label: "Rough cut", owner: "editor", carries: "Scenes, captions and the clip log.", done_when: "The review copy is uploaded, with everyone in it listed.", checklist: "Edit delivery: editor" },
    { key: "speaker_review", label: "Speaker review", owner: "producer", carries: "A REVIEW COPY on a link that expires, to the speaker (a minor's parent or guardian).", done_when: "Every speaker in the cut says yes in writing. A no goes back to the editor." },
    { key: "rights_check", label: "Rights check", owner: "producer", carries: "The screen checked against the release, marks cropped, archive notes, the NFLPA count, any disclosure line.", done_when: "What's on screen matches what each release covers.", checklist: "Release: producer" },
    { key: "final_signoff", label: "Final sign-off", owner: "producer", carries: "The final file and the post caption.", done_when: "The producer and Coach Hooks both say yes, saved in writing, or it waits." },
    { key: "publish", label: "Publish", owner: "owner", carries: "Instagram and TikTok, only the cuts their speakers approved.", done_when: "Every post is recorded here, so a takedown can find it." },
  ]),
  takedown: "If consent is pulled, the producer takes every version down within 72 hours.",
});

const TEMPLATES = Object.freeze({ "same-work": SAME_WORK });

function templateFor(slug) {
  return TEMPLATES[String(slug || "")] || null;
}

function stepFor(template, key) {
  return template ? template.steps.find((s) => s.key === key) || null : null;
}

// The checklist items for a step, from the given kit (approved), or [].
function checklistFor(kit, title) {
  if (!kit || !title || !Array.isArray(kit.columns)) return [];
  for (const c of kit.columns) {
    const card = (c.cards || []).find((x) => x.title === title && x.type === "todo");
    if (card) return (card.items || []).map(String);
  }
  return [];
}

// A note card from the kit as plain parts: each list item or paragraph, its
// bold lead apart. The page shows them as text, so the kit's HTML never
// reaches it. null when the kit has no such card.
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rarr: "→", larr: "←", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", times: "×" };
function plain(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") {
        const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 31 && n < 0x110000 ? String.fromCodePoint(n) : "";
      }
      return ENTITIES[e.toLowerCase()] !== undefined ? ENTITIES[e.toLowerCase()] : m;
    })
    .replace(/\s+/g, " ")
    .trim();
}
function cardFor(kit, title) {
  if (!kit || !title || !Array.isArray(kit.columns)) return null;
  for (const c of kit.columns) {
    const card = (c.cards || []).find((x) => x.title === title);
    if (!card) continue;
    if (card.type === "todo") return { title: card.title, parts: (card.items || []).map((x) => ({ lead: "", text: plain(x) })) };
    const parts = [];
    const re = /<(li|p)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let m;
    while ((m = re.exec(String(card.body || "")))) {
      const inner = m[2];
      const b = /^\s*<b>([\s\S]*?)<\/b>/i.exec(inner);
      const lead = b ? plain(b[1]) : "";
      const text = plain(b ? inner.slice(b[0].length) : inner);
      if (lead || text) parts.push({ lead, text });
    }
    return { title: card.title, parts };
  }
  return null;
}

// The kit's name pattern: SW_[lane]_[athleteID]_[format]_[ratio]_v[##]_[YYYYMMDD].
function fileNameFor(template, film, cut, date = new Date()) {
  if (!template) return "";
  const lane = template.lanes[film.lane];
  const fmt = template.formats[cut.format || film.format];
  const day = date.toISOString().slice(0, 10).replace(/-/g, "");
  const v = String(cut.version || 1).padStart(2, "0");
  return [template.file_prefix, lane ? lane.code : "LANE", film.athlete_id, fmt ? fmt.code : "FMT", cut.ratio || "9x16", "v" + v, day].join("_");
}

module.exports = { STEP_KEYS, OWNERS, TEMPLATES, templateFor, stepFor, checklistFor, cardFor, plain, fileNameFor };
