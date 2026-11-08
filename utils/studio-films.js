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
// One word of a minor's name (four letters or more) run into other letters
// ("#jordanstrong", "#teamjordan", "kiddquote", "Kiddstrong season"):
// { sure, maybe }. Where a word of the run starts or ends (its first or last
// letter, or a capital after a small letter), it's the name for certain,
// unless it's also an everyday word ("#hopestrong" for a Hope: asked); inside
// a word, asked ("#ourjordanfam"). The word alone is read by the other screens.
function minorRunIns(textValue, people) {
  const sure = new Set();
  const maybe = new Set();
  const runs = [];
  for (const m of String(textValue || "").matchAll(/[\p{L}\p{M}]+/gu)) {
    const tok = m[0];
    const edges = new Set([0, tok.length]);
    for (let i = 1; i < tok.length; i++) if (/\p{Lu}/u.test(tok[i]) && /\p{Ll}/u.test(tok[i - 1])) edges.add(i);
    runs.push({ low: tok.toLowerCase(), edges });
  }
  for (const p of people || []) {
    if (!p || !p.is_minor) continue;
    for (const w of nameParts(p.name)) {
      if (Array.from(w).length < 4) continue;
      for (const r of runs) {
        if (r.low === w) continue;
        for (let i = r.low.indexOf(w); i >= 0; i = r.low.indexOf(w, i + 1)) {
          if ((r.edges.has(i) || r.edges.has(i + w.length)) && !everyday(w)) sure.add(w);
          else maybe.add(w);
        }
      }
    }
  }
  for (const w of sure) maybe.delete(w);
  return { sure: [...sure], maybe: [...maybe] };
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
  // One word of a minor's name run into a word where a word starts or ends
  // ("jordanquote_v2", "quotejordan").
  for (const w of minorRunIns(raw, people).sure) out.add(w);
  return [...out];
}
// Names in a film's title. A title is read like a file name (any word of a
// card's name, in any case; a name run together), but it's words someone
// chose, so the screen asks where a word could be the everyday one: a word
// that's also an everyday word ("Game day" for a Dan Day, "Young and hungry"
// for a Chase Young), and a name run together inside a word, short of seven
// letters ("The walkout" for an Al Ko, "Redline" for an Ed Li). Sure: the
// whole name, any other word of it, a name run together from a word's start
// or of seven letters or more ("tynghero", "Jordankidd"). { sure, maybe }.
function titleNames(textValue, people) {
  const raw = String(textValue || "");
  const hay = " " + splitWords(raw).toLowerCase().replace(/[^\p{L}\p{M}]+/gu, " ") + " ";
  const tokens = raw.toLowerCase().split(/[^\p{L}\p{M}]+/u).filter(Boolean);
  const sure = new Set();
  const maybe = new Set();
  const look = (name, minor) => {
    const parts = nameParts(name);
    if (!parts.length) return;
    const joined = parts.join("");
    const len = Array.from(joined).length;
    if (parts.length > 1 && hay.includes(" " + parts.join(" ") + " ")) sure.add(parts.join(" "));
    if (parts.length > 1 && len >= (minor ? 4 : 5)) {
      for (const t of tokens) {
        const i = t.indexOf(joined);
        if (i < 0) continue;
        if (i === 0 || len >= 7) sure.add(joined);
        else maybe.add(joined);
      }
    }
    for (const w of parts) {
      if (Array.from(w).length < (minor ? 2 : 3) || EVERYDAY_2.has(w) || !hay.includes(" " + w + " ")) continue;
      if (!EVERYDAY_NAMES.has(w)) sure.add(w);
      // A minor's everyday-word name reads as a story's would: with a capital
      // in the middle of a title that isn't in Title Case ("Go Hope go",
      // "Thanks, Hope"), or as a possessive ("Hope's first season"), it's
      // the name; otherwise asked.
      else if (minor && (new RegExp(`(?<![\\p{L}\\p{M}])${w}['’]s(?![\\p{L}\\p{M}])`, "iu").test(raw) || (capitalizedMidSentence(raw, w) && !titleCase(raw)))) sure.add(w);
      else maybe.add(w);
    }
  };
  for (const p of people || []) {
    if (!p) continue;
    look(p.name, !!p.is_minor);
    if (p.reviewer_name) look(p.reviewer_name, false);
  }
  const runIn = minorRunIns(raw, people);
  for (const w of runIn.sure) sure.add(w);
  for (const w of runIn.maybe) maybe.add(w);
  for (const w of sure) maybe.delete(w);
  return { sure: [...sure], maybe: [...maybe] };
}
// A title or line in Title Case or capitals: three words or more, each with
// a capital but the small ones ("Keep the Faith", "GAME DAY GRIND").
const TITLE_SMALL = new Set("a an and as at but by for from in into nor of off on or over per the to up vs via with".split(" "));
function titleCase(line) {
  const words = String(line || "").replace(/[#@][\p{L}\p{M}\p{N}_.]+/gu, " ").match(/[\p{L}\p{M}][\p{L}\p{M}'’]*/gu) || [];
  const caps = words.filter((w) => /^\p{Lu}/u.test(w));
  return words.length >= 3 && caps.length >= 2 && words.every((w) => /^\p{Lu}/u.test(w) || TITLE_SMALL.has(w.toLowerCase()));
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

// What the director's phone keeps for a dead signal (shoot mode): the call
// times without what they're for (a call sheet line names people and places
// too often to keep), and only those must-haves and frame-pair lines a
// strict screen can't fault:
//   - no word of a card's name, in any case (idNames: "hope smiling" too);
//   - no word of a place under Locations, in any case;
//   - no contact, no "@", no digits;
//   - no capital after the first word ("Westlake HS", "St. Mary's"), and a
//     capital first word only if it's an ordinary one (COMMON_FIRST, or a
//     word of the approved kit's own text: "Hands", "Gate"), not "Dana" or
//     "Lincoln".
// A name that's on no card and typed all in lower case can't be told from
// other words, so the board says these lines go on the phone. The rest
// shows online only.
const PHONE_RE = /(?:\+?\d[\s().-]*){7,}/;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const LINK_RE = /\bhttps?:\/\/|\bwww\./i;
const STREET_RE = /\b\d{1,6}\s+(?:[\p{L}\p{N}.'-]+\s+){0,3}(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pl|place|hwy|highway|pkwy|parkway|cir|circle|ter|terrace|trl|trail)\b\.?/iu;
function contactIn(text) {
  const t = String(text || "");
  return PHONE_RE.test(t) || EMAIL_RE.test(t) || LINK_RE.test(t) || STREET_RE.test(t);
}
// The words of the places under Locations ("The Rivers family's driveway,
// 12 Oak St": rivers, family, driveway, oak, st), in any case, but the
// ordinary small ones ("the", "at") and three letters or fewer typed in
// lower case.
// Words a place's name has that don't say which place ("Westlake High School
// practice field" is Westlake's): a line with "after practice" or "on the
// field" stays on the phone; "westlake gym" doesn't.
const PLACE_SKIP = new Set(("the a an at of on in by and to for from near with s st street road rd ave avenue " +
  "high middle school practice field fields track gym court courts park family home").split(" "));
function placeWords(locations) {
  const out = new Set();
  for (const l of Array.isArray(locations) ? locations : []) {
    for (const w of String(l || "").match(/[\p{L}\p{M}]+/gu) || []) {
      const lw = w.toLowerCase();
      if (PLACE_SKIP.has(lw)) continue;
      if (/^\p{Lu}/u.test(w) || Array.from(lw).length >= 4) out.add(lw);
    }
  }
  return out;
}
// Ordinary words a shot line may start with, besides the kit's own words.
const COMMON_FIRST = new Set(("i we he she they it the a an his her their our my your its this that these those one two three four five first second third last next final " +
  "then after before during while when where over under behind beside between inside outside into onto off up down out back front side top " +
  "on in at by for from with without to of and but or no not all each every both same other another more most few some any " +
  "wide close tight medium slow fast low high long short full half empty quiet loud early late " +
  "sunday monday tuesday wednesday thursday friday saturday morning afternoon evening night dawn dusk sunrise sunset noon midnight " +
  "kids players team coach coaches parents crowd fans ball cones sled bench stands bleachers scoreboard whistle helmet cleats gloves tape " +
  "hands feet eyes shoulders breath sweat rain snow mud sun shadow shadows light lights silhouette reflection archive photo phone " +
  "drill drills rep reps sprint sprints run runs walk walks warmup warm stretch huddle practice game field court track gym gate door " +
  "b broll insert inserts cutaway cutaways establishing aerial overhead handheld locked static push pull pan tilt dolly track tracking " +
  // Family, crew and the things a shot list starts with (none of them a
  // common name: those stay out, so a line that starts with one is kept online).
  "dad dads mom moms mother father mothers fathers grandma grandpa grandmother grandfather uncle aunt brother brothers sister sisters son daughter " +
  "cousin cousins teammate teammates captain captains trainer trainers ref refs referee referees official officials " +
  "laces lace shoe shoes sneakers socks jersey jerseys uniform uniforms hat helmets mouthguard pads shoulder knee knees wrist wrists ankle ankles " +
  "headphones earbuds water bottle bottles towel towels bag bags backpack car truck van keys bus locker lockers hallway stairs steps stadium " +
  "fence net nets goal goals hoop rim bat bats glove mitt base bases plate plates mound dugout sideline sidelines endzone yard yards line lines " +
  "chains pylon pylons hurdle hurdles ladder ladders rope ropes tire tires band bands dumbbell dumbbells barbell rack bar mat mats chalk " +
  "clock timer stopwatch flag flags banner trophy trophies medal medals letter letters envelope notebook playbook clipboard whiteboard " +
  "screen laptop tablet camera mic microphone slate turf grass dirt sand pool steam fog wind clouds ice weight weights handshake handshakes " +
  "hug hugs footwork lap laps warmups cooldown stance snap snaps kickoff whistles timeout halftime overtime pregame postgame victory win wins " +
  "tears smile smiles laughter silence noise closeup timelapse macro detail details " +
  "kneeling running jogging sprinting lifting stretching throwing catching kicking jumping walking standing sitting waiting breathing tying " +
  "lacing praying laughing talking listening watching cheering clapping hugging dribbling shooting passing tackling blocking spinning " +
  "bouncing loading pushing pulling dripping rising falling").split(/\s+/));
function offlineSafe(text, people, { places = [], vocab = null } = {}) {
  const t = String(text || "").trim();
  if (!t || t.includes("@") || /\d/.test(t) || contactIn(t) || idNames(t, people).length) return false;
  const words = t.match(/[\p{L}\p{M}'’]+/gu) || [];
  const at = placeWords(places);
  if (words.some((w) => at.has(w.toLowerCase().replace(/['’]s?$/u, "")))) return false;
  if (words.slice(1).some((w) => /^\p{Lu}/u.test(w) && w !== "I")) return false;
  // A capital first word: an ordinary one, or one the kit's own text uses.
  const first = words[0] || "";
  if (/^\p{Lu}/u.test(first)) {
    const lw = first.toLowerCase().replace(/['’]s?$/u, "");
    if (!COMMON_FIRST.has(lw) && !(vocab && vocab.has(lw))) return false;
  }
  return true;
}
// The words of a kit's own text, lower case: what a shot line may start with.
function kitWords(kit) {
  const out = new Set();
  const walk = (v) => {
    if (typeof v === "string") for (const w of v.toLowerCase().match(/[\p{L}\p{M}]+/gu) || []) out.add(w);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(kit);
  return out;
}

// ── Words on a graphic ───────────────────────────────────────────────────
// Whether a graphic may name this person on this format: an adult (not a
// Texas youth athlete), cleared, consent standing, the release covering
// their name and listing the format.
function mayName(p, format) {
  return !!p && !p.is_minor && !p.texas_youth && !!p.cleared_at && !p.consent_pulled_at
    && !!(p.covers && p.covers.name === true) && Array.isArray(p.covers.formats) && p.covers.formats.includes(format);
}
const CREDIT_ROLE = { athlete: "athlete", parent: "parent", guardian: "parent", coach: "coach", other: "family" };
// The credit line a graphic may carry for its speaker (as: full | first | role).
function graphicsCredit(p, as, format) {
  if (!p) return { text: "Coached by Hooks", named: false };
  if (mayName(p, format) && (as === "full" || as === "first")) {
    return { text: `${as === "full" ? p.name : String(p.name).split(/\s+/)[0]} · Coached by Hooks`, named: true };
  }
  return { text: `A Coached by Hooks ${CREDIT_ROLE[p.role] || "athlete"}`, named: false };
}
// A graphic is public, and hashtags and handles run words together
// (#TyNgNeverQuit, @tyng23): its words are also read with the capitals in a
// run split apart, and a name run together counts anywhere inside a hashtag
// or a handle.
// Every word of a hashtag or a handle has its capital, and so does every
// word of a line of three words or more in Title Case or capitals ("Never
// Lose Hope", "GAME DAY GRIND"): a capital there says nothing, so each of
// those words reads as the start of a sentence ("#NeverLoseHope" asks about
// "hope", as "Hope never quits" does). A whole name is still a whole name
// ("#HopeFieldStrong"), and a short line keeps its reading ("Thanks Will").
const TAG = /[#@][\p{L}\p{M}\p{N}_.]+/gu;
// The small words a title leaves in lower case ("Keep the Faith").
const TITLE_SMALL = new Set("a an and as at but by for from in into nor of off on or over per the to up vs via with".split(" "));
function titleCaseLine(line) {
  const words = line.replace(TAG, " ").match(/[\p{L}\p{M}][\p{L}\p{M}'’]*/gu) || [];
  const caps = words.filter((w) => /^\p{Lu}/u.test(w));
  return words.length >= 3 && caps.length >= 2 && words.every((w) => /^\p{Lu}/u.test(w) || TITLE_SMALL.has(w.toLowerCase()));
}
function tagWords(tag) {
  return tag
    .slice(1)
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1\n$2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1\n$2")
    .replace(/(\p{L})(\p{N})|(\p{N})(\p{L})/gu, "$1$3\n$2$4")
    .replace(/[_.]+/g, "\n");
}
function publicText(all) {
  // Lines in Title Case: a word to a line. Tags: read from the split copy only.
  const lines = String(all || "").split(/\r?\n/).map((l) => (titleCaseLine(l) ? l.replace(/[^\S\n]+/g, "\n") : l)).join("\n");
  const split = lines
    .replace(TAG, (t) => "\n" + tagWords(t))
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .replace(/(\p{L})(\p{N})|(\p{N})(\p{L})/gu, "$1$3 $2$4");
  return lines.replace(TAG, " ") + "\n" + split;
}
// A name run together inside a hashtag or handle: { sure } when it starts
// where a word of the tag starts (its first letter, a capital after a small
// letter, a letter after a digit or "_": "#tyngneverquit", "@tyng23",
// "#GoTyNg"), when it ends where the tag or a word of it ends ("#teamtyng"),
// or when it's seven letters or more, too long to be chance
// ("#gojordankidd"); { ask } (the tag) when it's a short one inside a word
// ("edli" in "#SpeedLimit", "alko" in "#WalkOff"); or nothing.
function inTags(all, name, minRun) {
  const parts = nameParts(name);
  const joined = parts.join("");
  if (parts.length < 2 || Array.from(joined).length < minRun) return {};
  let sure = false;
  const ask = [];
  for (const tag of String(all || "").match(/[#@][\p{L}\p{M}\p{N}_.]+/gu) || []) {
    let letters = "";
    const starts = new Set();
    let prev = "";
    for (const ch of Array.from(tag.slice(1))) {
      if (/[\p{L}\p{M}]/u.test(ch)) {
        if (!letters || !/[\p{L}\p{M}]/u.test(prev) || (/\p{Lu}/u.test(ch) && /\p{Ll}/u.test(prev))) starts.add(letters.length);
        letters += ch.toLowerCase();
      }
      prev = ch;
    }
    const len = joined.length;
    for (let i = letters.indexOf(joined); i >= 0; i = letters.indexOf(joined, i + 1)) {
      // A word of the tag ends where the next one starts, or at its end.
      if (starts.has(i) || starts.has(i + len) || i + len === letters.length || Array.from(joined).length >= 7) sure = true;
      else ask.push(tag.toLowerCase());
    }
  }
  return { sure, ask: [...new Set(ask)] };
}
function publicNames(all, p) {
  const minor = !!p.is_minor;
  return strictNames(publicText(all), [{ name: p.name, is_minor: minor }]).length > 0 || !!inTags(all, p.name, minor ? 4 : 5).sure;
}
// What a graphic's words may not carry (the same rules as titles and file
// names, read as above): the name of anyone the release doesn't let it name,
// any word of a minor's name, a parent's or guardian's name (never on a
// graphic), or a banned word. Returns plain sentences.
function graphicsProblems(texts, people, { format = null, banned = null } = {}) {
  const all = (texts || []).filter(Boolean).join("\n");
  const out = [];
  for (const p of people || []) {
    if (publicNames(all, p) && !mayName(p, format)) {
      out.push(`The words name ${p.person_code}, whose release doesn't let a graphic name them on this format. Use the credit line the release allows.`);
    }
    if (p.reviewer_name && p.reviewer_relation !== "self" && publicNames(all, { name: p.reviewer_name })) {
      out.push(`The words name ${p.person_code}'s ${p.reviewer_relation}: a parent or guardian is never named on a graphic.`);
    }
  }
  if (banned && banned(all)) out.push("A word on the TOJ banned list is in the words. Say the concrete thing instead.");
  return [...new Set(out)];
}
// The words to ask about before a graphic goes (it can't carry a name its
// release doesn't allow): an everyday word that's also such a name, with a
// capital at the start of a sentence ("Will never quit"). ok: the words the
// writer said aren't names here.
function graphicsAsks(texts, people, { format = null, ok = new Set() } = {}) {
  const raw = (texts || []).filter(Boolean).join("\n");
  const all = publicText(raw);
  const out = new Set();
  for (const p of people || []) {
    if (!mayName(p, format)) {
      for (const w of nameHits(all, p, p.is_minor ? { minRun: 4, minWord: 2 } : {}).maybe) out.add(w);
      for (const tag of inTags(raw, p.name, p.is_minor ? 4 : 5).ask || []) out.add(tag);
    }
    if (p.reviewer_name && p.reviewer_relation !== "self") {
      for (const w of nameHits(all, { name: p.reviewer_name }).maybe) out.add(w);
      for (const tag of inTags(raw, p.reviewer_name, 5).ask || []) out.add(tag);
    }
  }
  return [...out].filter((w) => !ok.has(w));
}

// ── A film ───────────────────────────────────────────────────────────────
// partial: only the fields sent (an edit); otherwise a new film.
// current: the film as it is (an edit). A title or a story sent unchanged
// is read for certain names only: its questions were answered when it was
// saved, and a card added or changed since was read against it.
function filmInput(raw, { partial = false, people = [], namesOk = new Set(), current = null } = {}) {
  const r = raw && typeof raw === "object" ? raw : {};
  const errors = [];
  const asks = [];
  const v = {};
  const want = (k) => !partial || has(r, k);
  if (want("title")) {
    v.title = clean(r.title, 120);
    if (!v.title) errors.push("title");
    else {
      const t = titleNames(v.title, people);
      const same = current && current.title === v.title;
      if (t.sure.length) errors.push("title_has_name");
      else if (!same) {
        // An everyday word that's also a name: asked.
        const maybe = t.maybe.filter((w) => !namesOk.has(w));
        if (maybe.length) {
          errors.push("title_may_have_name");
          asks.push(...maybe);
        }
      }
    }
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
    const same = current && current.one_sentence === v.one_sentence;
    if (!v.one_sentence) {
      // nothing to read
    } else if (strictNames(v.one_sentence, people).length) errors.push("story_has_name");
    else if (!same) {
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

// A new or changed card, read against the film's title and story: a sure
// name in either stops it (they change first); an everyday word that's also
// this card's name is asked about ({ fields, words }), and the writer's "not a
// name here" (names_ok) counts for those words. Null when it's fine.
function cardAgainstFilm(film, person, namesOk = new Set()) {
  const t = titleNames(film && film.title, [person]);
  if (t.sure.length) return { error: "title_has_name" };
  const story = film && film.one_sentence;
  if (story && strictNames(story, [person]).length) return { error: "story_has_name" };
  const fields = [];
  const words = [];
  const tm = t.maybe.filter((w) => !namesOk.has(w));
  if (tm.length) {
    fields.push("title_may_have_name");
    words.push(...tm);
  }
  const sm = story ? strictMaybe(story, [person]).filter((w) => !namesOk.has(w)) : [];
  if (sm.length) {
    fields.push("story_may_have_name");
    words.push(...sm);
  }
  return fields.length ? { error: "invalid", fields, words: [...new Set(words)] } : null;
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

// ── The delivery check ───────────────────────────────────────────────────
// What the browser read from an exported file, checked against the kit:
// the format's length and ratios, the export sizes (1080×1920 for 9:16,
// 1080×1350 for 4:5), the name pattern (a warning) and no names in the file
// name (a failure). Nothing about the file leaves the phone but these numbers.
const KIT_SIZES = Object.freeze({ "9x16": [1080, 1920], "4x5": [1080, 1350] });
const RATIO_VALUE = Object.freeze({ "9x16": 9 / 16, "4x5": 4 / 5, "1x1": 1, "16x9": 16 / 9 });
function deliveryInput(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const errors = [];
  const num = (v, max) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n) : null;
  };
  const v = {
    file_name: clean(r.file_name, 200).replace(/[/\\]/g, ""),
    format: clean(r.format, 20).toLowerCase(),
    ratio: clean(r.ratio, 5).toLowerCase(),
    duration_ms: r.duration_ms === null || r.duration_ms === undefined ? null : num(r.duration_ms, 36000000),
    width: num(r.width, 20000),
    height: num(r.height, 20000),
    bytes: num(r.bytes, 50 * 1024 * 1024 * 1024),
  };
  if (!v.file_name) errors.push("file_name");
  if (!FORMATS.includes(v.format)) errors.push("format");
  if (!RATIOS.includes(v.ratio)) errors.push("ratio");
  if (!v.width || !v.height) errors.push("size");
  if (v.bytes === 0) v.bytes = null;
  return { errors, value: v };
}
function deliveryCheck(film, v, people = []) {
  const t = F.templateFor(film.kit_slug);
  const fmt = t && t.formats[v.format];
  const out = [];
  const add = (key, ok, text) => out.push({ key, ok, text });
  if (fmt && fmt.ratios && !fmt.ratios.includes(v.ratio)) add("ratio", false, `${fmt.label} is ${fmt.ratios.map((x) => x.replace("x", ":")).join(" or ")}, not ${v.ratio.replace("x", ":")}.`);
  const want = KIT_SIZES[v.ratio];
  if (v.width && v.height) {
    const actual = v.width / v.height;
    if (Math.abs(actual - RATIO_VALUE[v.ratio]) > 0.01) add("shape", false, `The file is ${v.width}×${v.height}, which isn't ${v.ratio.replace("x", ":")}.`);
    else if (want && (v.width !== want[0] || v.height !== want[1])) add("size", false, `Export at ${want[0]}×${want[1]} for ${v.ratio.replace("x", ":")}; this one is ${v.width}×${v.height}.`);
    else if (!want) add("size", "warn", `The kit names export sizes for 9:16 and 4:5 only.`);
    else add("size", true, `${v.width}×${v.height}, the kit's size for ${v.ratio.replace("x", ":")}.`);
  }
  if (fmt && fmt.seconds && v.duration_ms !== null) {
    const sec = v.duration_ms / 1000;
    const [lo, hi] = fmt.seconds;
    if (fmt.still && sec < 0.5) add("length", true, "A still.");
    else if (sec < lo - 0.5 || sec > hi + 0.5) add("length", false, `${fmt.label} runs ${fmt.spec.split(" · ")[0]}; this one is ${Math.round(sec)} seconds.`);
    else add("length", true, `${Math.round(sec)} seconds, inside ${lo}–${hi}.`);
  }
  const names = idNames(v.file_name.replace(/\.[a-z0-9]+$/i, ""), people);
  if (names.length) add("names", false, "The file name has a name in it. Files carry the athlete ID, never a name.");
  else add("names", true, "No names in the file name.");
  const warns = nameWarnings(v.file_name, film, { format: v.format, ratio: v.ratio, version: Number((/_v(\d{2,3})_/.exec(v.file_name) || [])[1]) || 1 });
  const pattern = warns.filter((w) => !/^Version/.test(w));
  if (pattern.length) add("pattern", "warn", "Not the kit's name pattern: " + pattern.join(" · "));
  else add("pattern", true, "Named the kit's way.");
  return { passed: !out.some((r) => r.ok === false), results: out };
}

// ── Notes and labels ─────────────────────────────────────────────────────
const label = (v) => {
  const s = clean(v, 60).toLowerCase().replace(/[^a-z0-9 '-]+/g, " ").replace(/\s+/g, " ").trim();
  return s.length >= 2 && /^[a-z0-9].*[a-z0-9]$/.test(s) ? s : null;
};

// ── Keys in storage ──────────────────────────────────────────────────────
const BUCKET = "studio-films";
const cutKey = (filmId, cutId, ext) => `films/${filmId}/cuts/${cutId}.${ext}`;
// A review copy is named by its content (the start of its sha256), and its
// poster after it: a copy is never overwritten, only added (migration 039).
const previewKey = (filmId, cutId, copySha) => `films/${filmId}/previews/${cutId}-${String(copySha || "").slice(0, 16)}.mp4`;
const posterKey = (filmId, cutId, copySha) => `films/${filmId}/previews/${cutId}-${String(copySha || "").slice(0, 16)}.jpg`;
// Stills and slides (migration 040): the files as uploaded, in order, and the
// copies speakers see (marked REVIEW COPY) in a folder named by the copies'
// own fingerprint, then 1.jpg, 2.jpg, ...
const slideKey = (filmId, cutId, n, ext = "png") => `films/${filmId}/slides/${cutId}/${n}.${ext === "jpg" ? "jpg" : "png"}`;
const slideCopyPrefix = (filmId, cutId, copySha) => `films/${filmId}/previews/${cutId}-${String(copySha || "").slice(0, 16)}/`;
// A ready set's copies, from its folder (none before it's made).
function slideCopyKeys(cut) {
  if (!cut || cut.kind !== "slides" || !cut.preview_key || !/\/$/.test(cut.preview_key)) return [];
  return (cut.slide_keys || []).map((_, i) => `${cut.preview_key}${i + 1}.jpg`);
}

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
  titleNames,
  titleCase,
  minorRunIns,
  cardAgainstFilm,
  EVERYDAY_2,
  EVERYDAY_NAMES,
  namesOkWords,
  planInput,
  offlineSafe,
  kitWords,
  mayName,
  graphicsCredit,
  graphicsProblems,
  graphicsAsks,
  contactIn,
  filmInput,
  coversInput,
  personInput,
  clearanceGaps,
  cutInput,
  nameWarnings,
  cutKey,
  previewKey,
  posterKey,
  slideKey,
  slideCopyPrefix,
  slideCopyKeys,
  KIT_SIZES,
  deliveryInput,
  deliveryCheck,
  label,
  reviewEmail,
  reviewReceipt,
  mailbox,
  email,
  cleanNotes,
  clean,
  UUID,
};
