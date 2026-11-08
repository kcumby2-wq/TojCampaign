"use strict";
// Studio films: what the film room takes in, checked (routes/studio-films.js,
// migration 039). Each checker returns { errors: [field names], value } and
// never throws on odd input. The database holds the hard lines too; this is
// where a person gets a clear refusal first.

const crypto = require("crypto");
const { clean, cleanNotes, email, mailbox, personName, UUID } = require("./pylon");
const F = require("../agents/studio/films");

const LANES = Object.freeze(["nfl", "college", "youth", "parent"]);
const FORMATS = Object.freeze(["hero", "cutdown", "sit_down", "parent_card", "quote_card", "same_drill", "own_words", "on_the_mic"]);
const RATIOS = Object.freeze(["9x16", "4x5", "1x1", "16x9"]);
const ROLES = Object.freeze(["athlete", "parent", "guardian", "coach", "other"]);
const RELATIONS = Object.freeze(["self", "parent", "guardian"]);
const PLATFORMS = Object.freeze(["instagram", "tiktok", "youtube", "facebook", "x", "threads", "other"]);
const TOOLS = Object.freeze({
  review_copies: "Review copies in storage",
  claude_transcripts: "Claude reads transcripts",
  graphics_system: "The graphics system",
});
const CODE = /^[A-Z0-9][A-Z0-9-]{1,19}$/;
const REVIEW_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_REVIEW_MB = () => {
  const n = Number(process.env.STUDIO_REVIEW_MAX_MB);
  return Number.isFinite(n) && n >= 5 && n <= 2048 ? n : 50;
};
const CONTENT_TYPES = Object.freeze({ mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v" });

const yes = (v) => v === true || v === "true" || v === "yes" || v === "on" || v === "1";
const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const https = (v) => {
  const s = clean(v, 500);
  if (!/^https:\/\/[^\s]+$/i.test(s)) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && u.hostname.includes(".") ? u.toString() : null;
  } catch {
    return null;
  }
};
const day = (v) => {
  const s = clean(v, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === s ? s : null;
};
const code = (v) => {
  const s = clean(v, 20).toUpperCase().replace(/\s+/g, "");
  return CODE.test(s) ? s : null;
};
const sha256 = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");

// ── People's names, kept out of titles and file names ────────────────────
// The kit: projects and files carry the athlete ID, never a name. The words of
// a card's name (3 letters or more), found as whole words, case aside.
// The names on cards (the person's and their reviewer's): each word of 3 or
// more letters, the whole name ("Al Ko"), and the name run together
// ("JamieRivers" in a file name). A lone two-letter first name isn't caught:
// it would catch "an" and "al" too.
const nameParts = (full) => String(full || "").toLowerCase().split(/[^\p{L}\p{M}]+/u).filter(Boolean);
function nameWords(people) {
  const words = new Set();
  for (const p of people || []) {
    for (const full of [p.name, p.reviewer_name]) for (const w of nameParts(full)) if (Array.from(w).length >= 3) words.add(w);
  }
  return [...words];
}
// { strong: true }: only what is certainly a name, a whole name of two words
// or more, or one run together (the database's screen, migration 039). By
// default a single word of a name counts too, which catches "Jamie's" but also
// "will" for a Will: notes ask before they keep one of those.
function namesIn(textValue, people, { strong = false } = {}) {
  // Apostrophes split words too, so a possessive ("Jamie's") is caught.
  const hay = " " + String(textValue || "").toLowerCase().replace(/[^\p{L}\p{M}]+/gu, " ") + " ";
  const found = new Set(strong ? [] : nameWords(people).filter((w) => hay.includes(" " + w + " ")));
  for (const p of people || []) {
    for (const full of [p.name, p.reviewer_name]) {
      const parts = nameParts(full);
      if (parts.length > 1 && hay.includes(" " + parts.join(" ") + " ")) found.add(parts.join(" "));
      // Run together as one word ("JamieRivers", "#jamierivers"): the whole
      // word, so "speed limits" is never "Ed Li".
      const joined = parts.join("");
      if (parts.length > 1 && Array.from(joined).length >= 5 && hay.includes(" " + joined + " ")) found.add(joined);
    }
  }
  return [...found];
}
// Two-letter words of a name that are also everyday words ("He", "Do",
// "So"): a child named Bo He mustn't stop every note with "he" in it. These
// count only written with a capital letter in the middle of a sentence
// ("talked to He's mom"), and the database leaves them to the app.
const EVERYDAY_2 = new Set(["he", "do", "an", "so", "go", "oh", "no", "me", "my", "we", "us", "it", "in", "on", "at", "to", "be", "by", "of",
  "or", "up", "as", "is", "am", "if", "hi", "ok", "ah", "eh", "uh", "um", "yo", "ya", "ha", "ho", "lo", "la", "ma", "pa", "ye", "ow", "ox", "ax", "id", "re", "vs"]);
function capitalizedMidSentence(raw, w) {
  const re = /[\p{L}\p{M}]+/gu;
  let m;
  while ((m = re.exec(raw))) {
    if (m[0].toLowerCase() !== w || m[0][0] === m[0][0].toLowerCase()) continue;
    const before = raw.slice(0, m.index);
    const gap = /\s*$/.exec(before)[0];
    const prev = before.slice(0, before.length - gap.length);
    if (!prev || gap.includes("\n") || /[.!?:;"“(\[—–-]$/.test(prev)) continue;
    return true;
  }
  return false;
}
// Words of three letters or more that are everyday words and names too
// ("will", "hope", "field", "young"): like the two-letter ones, a minor's
// counts only with a capital in the middle of a sentence ("talked to Will
// after"), and is asked about at the start of one ("Will you send it?").
// Lower case, it's the everyday word. The database leaves these to the app
// (migration 039's studio_names_in has the same list).
const EVERYDAY_NAMES = new Set(("ace april archer art ash august autumn baker bear bell best bill bird bishop black bliss blue bond booth brook brooks " +
  "brown buck buddy bush butler carter case cash chance chase church clay cliff colt cook cooper crow dale dash dawn day deal dean don dot dove drew duke " +
  "dusty early earl echo eve fair faith fern field fields fisher flint ford forest fox frank free frost gale gene gold golden grace grant gray green grey " +
  "guy hall hardy hart haven hawk hazel heath hero hill hills holly honey honor hood hope house hunt hunter ivy jack jade jay jet jewel joy judge june " +
  "justice kind king kit knight lake lance lane lark laurel legend liberty light lily link long lord love lucky major march mark marsh mason max may " +
  "meadow mercy miles misty moon noble north ocean page park pat patience peace pearl penny pepper pierce piper pope porter power price pride prince " +
  "queen rain ranger raven ray read rebel reed rice rich ridge river rob rock rocky rose royal ruby rush rusty sage saint sandy scout shade shadow " +
  "shepherd shore short silver sky small smith snow sonny south spring star steel sterling stone storm stormy strong sue summer sunday sunny sweet " +
  "swift tad tank true trust tucker valor violet wade walker ward warren waters way wells west white will willow winter wise wolf wood woods worth wren young").split(" "));
const everyday = (w) => EVERYDAY_2.has(w) || EVERYDAY_NAMES.has(w);
function capitalizedAtStart(raw, w) {
  const re = /[\p{L}\p{M}]+/gu;
  let m;
  while ((m = re.exec(raw))) {
    if (m[0].toLowerCase() !== w || m[0][0] === m[0][0].toLowerCase()) continue;
    const before = raw.slice(0, m.index);
    const gap = /\s*$/.exec(before)[0];
    const prev = before.slice(0, before.length - gap.length);
    if (!prev || gap.includes("\n") || /[.!?:;"“(\[—–-]$/.test(prev)) return true;
  }
  return false;
}
// Where a text names a person, for certain or maybe: their whole name; the
// name run together as one word ("#TyNg", "JamieRivers": the whole token,
// from minRun letters); a word of their name that's no everyday word, in any
// case; an everyday one with a capital mid-sentence. "maybe": an everyday one
// of three letters or more with a capital at the start of a sentence.
function nameHits(textValue, person, { minRun = 5, minWord = 3 } = {}) {
  const raw = String(textValue || "");
  const hay = " " + raw.toLowerCase().replace(/[^\p{L}\p{M}]+/gu, " ") + " ";
  const tokens = new Set(raw.toLowerCase().split(/[^\p{L}\p{M}]+/u).filter(Boolean));
  const sure = new Set();
  const maybe = new Set();
  const parts = nameParts(person && person.name);
  if (parts.length > 1 && hay.includes(" " + parts.join(" ") + " ")) sure.add(parts.join(" "));
  const joined = parts.join("");
  if (parts.length > 1 && Array.from(joined).length >= minRun && tokens.has(joined)) sure.add(joined);
  for (const w of parts) {
    if (Array.from(w).length < minWord || !hay.includes(" " + w + " ")) continue;
    if (!everyday(w)) sure.add(w);
    else if (capitalizedMidSentence(raw, w)) sure.add(w);
    // "He was great": a two-letter everyday word starts sentences all the time.
    else if (!EVERYDAY_2.has(w) && capitalizedAtStart(raw, w)) maybe.add(w);
  }
  return { sure: [...sure], maybe: [...maybe] };
}
// The words of a minor's name a text has for certain (two letters or more;
// run together from four). A note never keeps one, whatever its writer says:
// there's no "it isn't a name here" for a child's name (the database refuses
// the same, migration 039's studio_names_in). minorMaybe: the ones to ask
// about (an everyday word with a capital at the start of a sentence).
function minorWords(textValue, people) {
  const out = new Set();
  for (const p of people || []) if (p && p.is_minor) for (const w of nameHits(textValue, p, { minRun: 4, minWord: 2 }).sure) out.add(w);
  return [...out];
}
function minorMaybe(textValue, people) {
  const out = new Set();
  for (const p of people || []) if (p && p.is_minor) for (const w of nameHits(textValue, p, { minRun: 4, minWord: 2 }).maybe) out.add(w);
  return [...out];
}
// The strict screen, for what's shown or sent beyond the cards (a title, the
// one-sentence story the speaker's page shows, a file name): a card's whole
// name or one run together, a word of it of three letters or more (two, for
// a minor), the reviewer's name too. An everyday word ("will", "he") counts
// only with a capital mid-sentence.
function strictNames(textValue, people) {
  const out = new Set();
  for (const p of people || []) {
    if (!p) continue;
    const minor = !!p.is_minor;
    for (const w of nameHits(textValue, p, { minRun: minor ? 4 : 5, minWord: minor ? 2 : 3 }).sure) out.add(w);
    if (p.reviewer_name) for (const w of nameHits(textValue, { name: p.reviewer_name }).sure) out.add(w);
  }
  return [...out];
}
// The words of a card's name a sentence may hold, to ask about: an everyday
// word that's also a name, with a capital at the start of a sentence ("Hope
// never quits"). strictNames has the sure ones.
function strictMaybe(textValue, people) {
  const out = new Set();
  for (const p of people || []) {
    if (!p) continue;
    const minor = !!p.is_minor;
    for (const w of nameHits(textValue, p, { minRun: minor ? 4 : 5, minWord: minor ? 2 : 3 }).maybe) out.add(w);
    if (p.reviewer_name) for (const w of nameHits(textValue, { name: p.reviewer_name }).maybe) out.add(w);
  }
  return [...out];
}
// Names in a label or a file name (a title, a cut's or a set's file name):
// it isn't a sentence, so it's read harder. Its words are split where they
// run together (camelCase, digits, _ - .); any word of a card's name counts
// in any case, an everyday word too ("hope_quote_v02"), but a two-letter
// everyday one ("in", "an"); and a name run together counts anywhere inside
// a word ("tyngquotecard"), from five letters (four for a minor).
function splitWords(raw) {
  return String(raw || "").replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2").replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2");
}
function idNames(textValue, people) {
  const raw = String(textValue || "");
  const hay = " " + splitWords(raw).toLowerCase().replace(/[^\p{L}\p{M}]+/gu, " ") + " ";
  const tokens = raw.toLowerCase().split(/[^\p{L}\p{M}]+/u).filter(Boolean);
  const out = new Set();
  const look = (name, minor) => {
    const parts = nameParts(name);
    if (!parts.length) return;
    const joined = parts.join("");
    if (parts.length > 1 && hay.includes(" " + parts.join(" ") + " ")) out.add(parts.join(" "));
    if (parts.length > 1 && Array.from(joined).length >= (minor ? 4 : 5) && tokens.some((t) => t.includes(joined))) out.add(joined);
    for (const w of parts) {
      if (Array.from(w).length < (minor ? 2 : 3) || EVERYDAY_2.has(w)) continue;
      if (hay.includes(" " + w + " ")) out.add(w);
    }
  };
  for (const p of people || []) {
    if (!p) continue;
    look(p.name, !!p.is_minor);
    if (p.reviewer_name) look(p.reviewer_name, false);
  }
  return [...out];
}
// The words a writer said aren't names here ({ names_ok: ["will"] }), as a
// set of lower-case words. Anything else (true, a string) acknowledges nothing.
function namesOkWords(v) {
  if (!Array.isArray(v)) return new Set();
  return new Set(v.slice(0, 20).map((w) => String(w || "").normalize("NFC").toLowerCase().trim()).filter((w) => w && w.length <= 80));
}

// ── The board's structured parts ─────────────────────────────────────────
function list(v, max) {
  return Array.isArray(v) ? v.slice(0, max) : [];
}
function planInput(raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const v = {};
  v.references = list(r.references, 5)
    .map((x) => ({ url: x && x.url ? https(x.url) : null, note: clean(x && x.note, 300) }))
    .filter((x) => x.url || x.note);
  v.song = clean(r.song, 120) || null;
  const sp = r.speaker && typeof r.speaker === "object" ? r.speaker : {};
  v.speaker = {};
  for (const k of ["role_in_life", "how_world_sees", "how_hooks_sees", "wants", "at_stake"]) v.speaker[k] = clean(sp[k], 300) || null;
  v.quotes = list(r.quotes, 20)
    .map((q) => ({ quote: clean(q && q.quote, 300), question: clean(q && q.question, 300) }))
    .filter((q) => q.quote || q.question);
  v.must_have = list(r.must_have, 3).map((s) => clean(s, 200)).filter(Boolean);
  const fp = r.frame_pair && typeof r.frame_pair === "object" ? r.frame_pair : {};
  v.frame_pair = { opening: clean(fp.opening, 200) || null, closing: clean(fp.closing, 200) || null };
  v.shoot_date = day(r.shoot_date);
  v.locations = list(r.locations, 10).map((s) => clean(s, 120)).filter(Boolean);
  v.schedule = list(r.schedule, 20)
    .map((x) => ({ time: /^([01]\d|2[0-3]):[0-5]\d$/.test(clean(x && x.time, 5)) ? clean(x.time, 5) : null, what: clean(x && x.what, 120) }))
    .filter((x) => x.what);
  return v;
}

// ── A film ───────────────────────────────────────────────────────────────
// partial: only the fields sent (an edit); otherwise a new film.
function filmInput(raw, { partial = false, people = [], namesOk = new Set() } = {}) {
  const r = raw && typeof raw === "object" ? raw : {};
  const errors = [];
  const asks = [];
  const v = {};
  const want = (k) => !partial || has(r, k);
  if (want("title")) {
    v.title = clean(r.title, 120);
    if (!v.title) errors.push("title");
    else if (idNames(v.title, people).length) errors.push("title_has_name");
  }
  if (want("lane")) {
    v.lane = clean(r.lane, 20).toLowerCase();
    if (!LANES.includes(v.lane)) errors.push("lane");
  }
  if (want("athlete_id")) {
    v.athlete_id = code(r.athlete_id);
    if (!v.athlete_id) errors.push("athlete_id");
  }
  if (want("format")) {
    v.format = clean(r.format, 20).toLowerCase();
    if (!FORMATS.includes(v.format)) errors.push("format");
  }
  if (has(r, "one_sentence")) {
    // The story is on the speaker's review page: never a name.
    v.one_sentence = clean(r.one_sentence, 300) || null;
    if (v.one_sentence && strictNames(v.one_sentence, people).length) errors.push("story_has_name");
    else if (v.one_sentence) {
      // An everyday word that's also a name, starting a sentence: asked.
      const maybe = strictMaybe(v.one_sentence, people).filter((w) => !namesOk.has(w));
      if (maybe.length) {
        errors.push("story_may_have_name");
        asks.push(...maybe);
      }
    }
  }
  if (has(r, "post_date")) {
    v.post_date = r.post_date ? day(r.post_date) : null;
    if (r.post_date && !v.post_date) errors.push("post_date");
  }
  if (has(r, "board_url")) {
    v.board_url = r.board_url ? https(r.board_url) : null;
    if (r.board_url && !v.board_url) errors.push("board_url");
  }
  for (const k of ["director_email", "editor_email"]) {
    if (has(r, k)) {
      v[k] = r[k] ? email(r[k]) : null;
      if (r[k] && !v[k]) errors.push(k);
    }
  }
  if (has(r, "gfs_event_id")) {
    v.gfs_event_id = r.gfs_event_id ? (UUID.test(String(r.gfs_event_id)) ? String(r.gfs_event_id).toLowerCase() : null) : null;
    if (r.gfs_event_id && !v.gfs_event_id) errors.push("gfs_event_id");
  }
  if (has(r, "plan")) v.plan = planInput(r.plan);
  return { errors, value: v, asks: [...new Set(asks)] };
}

// ── A clearance card ─────────────────────────────────────────────────────
// What the release covers: face, name, jersey, voice, and which formats.
function coversInput(raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    face: yes(r.face),
    name: yes(r.name),
    jersey: yes(r.jersey),
    voice: yes(r.voice),
    formats: list(r.formats, FORMATS.length).map((f) => clean(f, 20).toLowerCase()).filter((f, i, a) => FORMATS.includes(f) && a.indexOf(f) === i),
  };
}
function personInput(raw, { partial = false, current = null } = {}) {
  const r = raw && typeof raw === "object" ? raw : {};
  const errors = [];
  const v = {};
  const want = (k) => !partial || has(r, k);
  if (!partial) {
    v.person_code = code(r.person_code);
    if (!v.person_code) errors.push("person_code");
  }
  if (want("name")) {
    v.name = personName(r.name);
    if (!v.name) errors.push("name");
  }
  if (want("role")) {
    v.role = clean(r.role, 20).toLowerCase();
    if (!ROLES.includes(v.role)) errors.push("role");
  }
  for (const k of ["is_minor", "texas_youth", "speaker", "release_on_file"]) if (want(k)) v[k] = yes(r[k]);
  if (want("covers")) v.covers = coversInput(r.covers);
  const merged = { ...(current || {}), ...v };
  // Minors stay unidentifiable: no face, name or jersey number on screen
  // (Kyron's rule; the kit's for Texas youth, who are minors).
  if (merged.texas_youth) merged.is_minor = v.is_minor = true;
  if (merged.is_minor) {
    const c = merged.covers || coversInput({});
    if (c.face || c.name || c.jersey || want("is_minor") || want("texas_youth") || want("covers")) {
      merged.covers = v.covers = { ...c, face: false, name: false, jersey: false };
    }
  }
  // A new consent, after a pull (the producer records it).
  if (has(r, "reconsent_note")) {
    v.reconsent_note = cleanNotes(r.reconsent_note, 500) || null;
    if (r.reconsent_note && (!v.reconsent_note || Array.from(v.reconsent_note).length < 3)) errors.push("reconsent_note");
  }
  // Who approves the cut: the person (adult) or their parent or legal guardian.
  if (want("reviewer_relation") || want("reviewer_name") || want("reviewer_email") || want("is_minor") || want("texas_youth")) {
    const rel = has(r, "reviewer_relation") ? clean(r.reviewer_relation, 20).toLowerCase() : merged.reviewer_relation || "";
    const name = has(r, "reviewer_name") ? personName(r.reviewer_name) : merged.reviewer_name || null;
    const mail = has(r, "reviewer_email") ? email(r.reviewer_email) : merged.reviewer_email || null;
    if (has(r, "reviewer_email") && r.reviewer_email && !mail) errors.push("reviewer_email");
    if (has(r, "reviewer_name") && r.reviewer_name && !name) errors.push("reviewer_name");
    if (rel || name || mail) {
      if (!RELATIONS.includes(rel)) errors.push("reviewer_relation");
      else if (merged.is_minor && rel === "self") errors.push("minor_needs_parent");
      else if (!merged.is_minor && rel !== "self") errors.push("adult_reviews_self");
      if (!name) errors.push("reviewer_name");
      if (!mail) errors.push("reviewer_email");
      v.reviewer_relation = rel || null;
      v.reviewer_name = name;
      v.reviewer_email = mail;
    } else {
      v.reviewer_relation = v.reviewer_name = v.reviewer_email = null;
    }
  }
  return { errors: [...new Set(errors)], value: v };
}

// What's still missing before a card can be cleared.
function clearanceGaps(p) {
  const gaps = [];
  if (!p.release_on_file) gaps.push("No release on file");
  if (p.speaker && !p.reviewer_email) gaps.push("Who approves the cut (the speaker, or a minor's parent or guardian)");
  if (p.is_minor && p.speaker && p.reviewer_relation === "self") gaps.push("A minor's cut is approved by a parent or guardian");
  return gaps;
}

// ── A cut ────────────────────────────────────────────────────────────────
function cutInput(raw, { people = [], filmPeople = [] } = {}) {
  const r = raw && typeof raw === "object" ? raw : {};
  const errors = [];
  const v = {};
  v.format = clean(r.format, 20).toLowerCase();
  if (!FORMATS.includes(v.format)) errors.push("format");
  v.ratio = clean(r.ratio, 5).toLowerCase();
  if (!RATIOS.includes(v.ratio)) errors.push("ratio");
  v.version = Number(r.version);
  if (!Number.isInteger(v.version) || v.version < 1 || v.version > 999) errors.push("version");
  v.file_name = clean(r.file_name, 200).replace(/[/\\]/g, "");
  const ext = (/\.([a-z0-9]{2,4})$/i.exec(v.file_name) || [])[1];
  v.ext = ext ? ext.toLowerCase() : "";
  if (!v.file_name || !CONTENT_TYPES[v.ext]) errors.push("file_name");
  else if (idNames(v.file_name.replace(/\.[a-z0-9]+$/i, ""), filmPeople).length) errors.push("file_name_has_name");
  v.content_type = CONTENT_TYPES[v.ext] || null;
  v.bytes = Number(r.bytes);
  if (!Number.isInteger(v.bytes) || v.bytes <= 0) errors.push("bytes");
  else if (v.bytes > MAX_REVIEW_MB() * 1024 * 1024) errors.push("too_big");
  const ids = new Set(filmPeople.map((p) => p.id));
  v.people = [...new Set(list(r.people, 50).map((x) => String(x).toLowerCase()))];
  if (v.people.some((id) => !UUID.test(id) || !ids.has(id))) errors.push("people");
  void people;
  return { errors, value: v };
}

// How a file name reads against the kit's pattern (warnings, never refusals:
// the kit names only some of the codes).
function nameWarnings(fileName, film, cut) {
  const t = F.templateFor(film.kit_slug);
  if (!t) return [];
  const base = String(fileName || "").replace(/\.[a-z0-9]+$/i, "");
  const parts = base.split("_");
  const out = [];
  const lane = t.lanes[film.lane];
  const fmt = t.formats[cut.format];
  if (parts.length !== 7 || parts[0] !== t.file_prefix) out.push(`The kit names files ${F.fileNameFor(t, film, cut)}.mp4`);
  else {
    if (lane && parts[1] !== lane.code) out.push(`Lane: ${lane.code}`);
    if (parts[2] !== film.athlete_id) out.push(`Athlete ID: ${film.athlete_id}`);
    if (fmt && parts[3] !== fmt.code) out.push(`Format: ${fmt.code}`);
    if (parts[4] !== cut.ratio) out.push(`Ratio: ${cut.ratio}`);
    if (!/^v\d{2,3}$/.test(parts[5]) || Number(parts[5].slice(1)) !== cut.version) out.push(`Version: v${String(cut.version).padStart(2, "0")}`);
    if (!/^\d{8}$/.test(parts[6])) out.push("Date: YYYYMMDD");
  }
  return out;
}

// ── Keys in storage ──────────────────────────────────────────────────────
const BUCKET = "studio-films";
const cutKey = (filmId, cutId, ext) => `films/${filmId}/cuts/${cutId}.${ext}`;
// A review copy is named by its content (the start of its sha256), and its
// poster after it: a copy is never overwritten, only added (migration 039).
const previewKey = (filmId, cutId, copySha) => `films/${filmId}/previews/${cutId}-${String(copySha || "").slice(0, 16)}.mp4`;
const posterKey = (filmId, cutId, copySha) => `films/${filmId}/previews/${cutId}-${String(copySha || "").slice(0, 16)}.jpg`;

// ── What people read ─────────────────────────────────────────────────────
const RELATION_WORDS = { self: "you", parent: "your child", guardian: "the athlete in your care" };

function reviewEmail({ reviewerName, relation, formatLabel, link, expiresAt, producerName = "Kyron" }) {
  const hi = String(reviewerName || "").trim().split(/\s+/)[0] || "there";
  const who = relation === "self" ? "you" : relation === "parent" ? "your child" : "the athlete in your care";
  const until = new Date(expiresAt).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/New_York" });
  return {
    subject: "A review copy is ready for your OK",
    text:
      `Hi ${hi},\n\n` +
      `A REVIEW COPY of a Same Work ${formatLabel.toLowerCase()} with ${who} is ready. Nothing goes out until you say yes.\n\n` +
      `Watch it here, then approve it or ask for a change:\n${link}\n\n` +
      `The link works once and stops working on ${until}. Please don't forward it: anyone with it can answer for you. ` +
      `We'll email you a receipt when it's used.\n\n` +
      `If you'd rather talk it through, call or text ${producerName}. Please don't reply to this email with the link in it.\n\n` +
      `Same Work`,
  };
}

function reviewReceipt({ reviewerName, decision, formatLabel, decidedName }) {
  const hi = String(reviewerName || "").trim().split(/\s+/)[0] || "there";
  const said = decision === "approved" ? "approved" : "asked for a change to";
  return {
    subject: decision === "approved" ? "You approved the review copy" : "You asked for a change",
    text:
      `Hi ${hi},\n\n` +
      `${decidedName} just ${said} the Same Work ${formatLabel.toLowerCase()} on your review link. ` +
      (decision === "approved"
        ? "Nothing else is needed from you. It still waits for the producer's final sign-off before anything goes out.\n\n"
        : "The editor gets your note, and you'll get a new review copy to look at.\n\n") +
      `If that wasn't you, call or text Kyron right away: we'll stop it.\n\n` +
      `You can take your yes back at any time, and if you pull consent, every version comes down within 72 hours.\n\n` +
      `Same Work`,
  };
}

module.exports = {
  LANES,
  FORMATS,
  RATIOS,
  ROLES,
  RELATIONS,
  PLATFORMS,
  TOOLS,
  CODE,
  REVIEW_TTL_MS,
  MAX_REVIEW_MB,
  CONTENT_TYPES,
  BUCKET,
  RELATION_WORDS,
  yes,
  https,
  day,
  code,
  sha256,
  nameWords,
  namesIn,
  minorWords,
  minorMaybe,
  nameHits,
  strictNames,
  strictMaybe,
  idNames,
  EVERYDAY_2,
  EVERYDAY_NAMES,
  namesOkWords,
  planInput,
  filmInput,
  coversInput,
  personInput,
  clearanceGaps,
  cutInput,
  nameWarnings,
  cutKey,
  previewKey,
  posterKey,
  reviewEmail,
  reviewReceipt,
  mailbox,
  email,
  cleanNotes,
  clean,
  UUID,
};
