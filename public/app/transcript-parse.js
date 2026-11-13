/* Transcripts from DaVinci Resolve (and most editors): SubRip (.srt),
 * WebVTT (.vtt), or plain text with a timecode on or above each line.
 *
 * Read in the browser: only the words of the speaker picked go to the
 * server, so the interviewer's questions and anyone else's words never leave
 * the computer. The server keeps nothing it can't check with this same code
 * (utils/studio-words.js requires this file).
 *
 *   parse(text, { fps })          → { ok, format, frames, cues: [{ n, s, e, t, who, gap }], speakers: [{ who, cues }], labelled, mixed, error }
 *   only(cues, who, { pauses })   → that speaker's cues, numbered again from 1; a cue after
 *                                   someone else's (a question) is marked gap: a line never bridges it;
 *                                   so is one after a long pause, in a file with no labels (pauses: true)
 *
 * who: a speaker's label (typed, a voice tag, "Speaker 1", or a name in
 * brackets: "[COACH]"); "" for a line whose voice the file doesn't say (no
 * label before any label, in a file that has labels); TWO for what's
 * nobody's, never picked, counted in mixed: a part of a subtitle with two
 * voices in it ("- " or "-" lines, ">>" lines, ">>" in the middle of a line)
 * that has no label of its own, words before a colon that don't look like a
 * label, words after a voice in brackets ("[man]", "[crowd chanting]", or
 * a name in brackets in a file with no labels; a note, "[APPLAUSE]",
 * "[laughs nervously]", "[in Spanish]", "[bleep]", isn't one), a line all in
 * italics or sung ("<i>Why?</i>", "♪ …"), a line of a ">>" file with no
 * label, and, in a file with labels, what follows any of these until the
 * next label; null only in a file with no labels at all. A subtitle with two voices or two labels in it
 * is split into one cue for each.
 *   voices: how many voices can be picked (labelled files: a pause is a gap
 *   in only() unless there are two or more).
 *   find(cues, from, to, quote)   → the quote's exact words in cues from..to, and when they're said
 *   tc(ms, { frames, fps })       → "00:01:23.4", or "00:01:23:10" for a frame-based transcript
 *
 * Times are milliseconds from the transcript's own zero (a Resolve timeline
 * often starts at 01:00:00:00, and that's kept, so a timecode here is the one
 * in the edit).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TOJTranscript = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var FPS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
  var MAX_CUES = 5000;
  var MAX_CUE = 2000;
  var MAX_TOTAL = 300000;
  var MAX_MS = 36000000; // ten hours

  // 00:01:23:12 · 00:01:23;12 (drop-frame), 00:01:23,456 · 00:01:23.456 ·
  // 01:23.456 (WebVTT may leave the hours out), 00:01:23.
  var FR = "\\d{1,2}:\\d{2}:\\d{2}[:;]\\d{2}";
  var MS = "(?:\\d{1,2}:)?\\d{1,2}:\\d{2}[.,]\\d{1,3}";
  var HMS = "\\d{1,2}:\\d{2}:\\d{2}";
  var ANY = "(?:" + FR + "|" + MS + "|" + HMS + ")";
  var ARROW = new RegExp("^\\s*(" + FR + "|" + MS + ")\\s*-->\\s*(" + FR + "|" + MS + ")(?:\\s|$)");
  var LEAD_TC = new RegExp("^\\s*\\[?\\s*(" + ANY + ")\\s*\\]?(?:\\s*(?:-|–|—|to)\\s*\\[?\\s*(" + ANY + ")\\s*\\]?)?(?:\\s+|$)(.*)$");

  function msOf(stamp, fps) {
    var m = /^(\d{1,2}):(\d{2}):(\d{2})[:;](\d{2})$/.exec(stamp);
    if (m) {
      if (!fps) return { frames: true, ms: null };
      return { frames: true, ms: Math.round(((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3]) + Number(m[4]) / fps) * 1000) };
    }
    m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(stamp);
    if (m) return { frames: false, ms: ((Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Math.round(Number("0." + m[4]) * 1000) };
    m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(stamp);
    if (m) return { frames: false, ms: ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 };
    return null;
  }

  // Words the transcript says are missing ("[inaudible]", "[crosstalk]"):
  // kept as a mark a line never reaches across.
  var MISSING = "\u27e8\u2026\u27e9";
  var MISSING_RE = /\[\s*(?:inaudible|unintelligible|crosstalk|cross[- ]talk|overlapping|overtalk|indistinct|unclear|garbled|muffled|\?+)[^\]]{0,40}\]/gi;
  // A pause this long between two of a speaker's cues: a line doesn't reach
  // across it (something may have been said in between and cut).
  var PAUSE_MS = 3000;
  // What a line of a cue says: tags, positions, sound notes and music out.
  function cleanText(s) {
    return String(s || "")
      .replace(/\{\\[^}]*\}/g, " ")
      .replace(/<\/?(?:i|b|u|c|v|font|ruby|rt|lang|span)\b[^>]*>/gi, "")
      .replace(/<\d{1,2}:\d{2}[^>]*>/g, "")
      .replace(MISSING_RE, " " + MISSING + " ")
      .replace(/\[[^\]]{0,60}\]/g, " ")
      .replace(/\(([^()]{1,40})\)/g, function (m, x) { return MANNER.test(x.trim()) ? " " : m; })
      .replace(/[♪♫]+/g, " ")
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  // A speaker's label the editor typed: "Speaker 1:", "COACH:", "Pat R.:",
  // "JOSÉ:" (any alphabet). At the start of a subtitle or of a dashed line,
  // any words before a colon may be one; on a later line, only what looks
  // like a label ("INTERVIEWER: Why that year?"): a wrapped line ("for all
  // of us: show up") is words.
  // A note after the name ("INTERVIEWER (O.S.):", "COACH (V.O.):", "PAT
  // (CONT'D):"), as documentary transcripts write it, is the label's too.
  var LABEL = /^\s*(\p{L}[\p{L}\p{M}\p{N} .'’-]{0,38}?)\s*(?:\(\s*(?:[oO]\.?\s?[sS]\.?|[vV]\.?\s?[oO]\.?|[cC][oO][nN][tT]['’]?[dD]\.?|[oO][fF][fF][- ]?(?:[sS][cC][rR][eE][eE][nN]|[cC][aA][mM][eE][rR][aA])|[oO][nN][- ]?(?:[sS][cC][rR][eE][eE][nN]|[cC][aA][mM][eE][rR][aA])|[iI][nN][tT][oO] [pP][hH][oO][nN][eE])\s*\))?\s*:\s+(\S.*)$/u;
  // What a label looks like: all capitals, "Speaker 2", or one to three words
  // each with a capital ("Coach", "Pat R.", "Mrs Lopez"). Anything else
  // before a colon is a label only in a file that has labels, and then a
  // voice the file doesn't say ("").
  var LABEL_LIKE = /^(?:speaker\s*\d{1,2}|[\p{Lu}\p{M}\p{N} .'’-]+|\p{Lu}[\p{L}\p{M}.'’-]*(?:\s+\p{Lu}[\p{L}\p{M}.'’-]*){0,2})$/u;
  // Capitalised words that start a sentence with a colon, never a speaker
  // ("Saturday: run it again", "Listen: you show up"): on a line after the
  // first, they're words.
  var NOT_LABEL = /^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|today|tonight|tomorrow|yesterday|listen|look|remember|note|rule|lesson|step|first|second|third|last|now|then|well|so|and|but|yes|no|okay|ok|honestly|seriously|basically|again|always|never|answer|question)$/i;
  // Someone quoting someone ("He said: ..."): never a label.
  // Written once in a file with no labels, a line starting with one of
  // these is words, not another voice ("Day one: we ran it", "Touchdown:").
  var ONCE_WORDS = /^(?:day|days|week|weeks|year|years|game|games|final|finals|score|halftime|overtime|touchdown|goal|quarter|round|period|inning|set|match|update|reminder|fact|truth|tip|warning|result|record|chapter|part|scene|take|quote|title|motto|moral|mantra|message|summary|morning|night|tonight|practice)$/i;
  var SPEECH = /\b(?:said|says|say|asked|asks|ask|told|tells|tell|replied|replies|added|adds|explained|explains|yelled|yells|shouted|shouts|whispered|goes|went)\b/i;
  // A part of a subtitle with two voices in it and no label of its own.
  var TWO = "\u0000two";
  // A voice tag, anywhere in a line: <v Coach>, <v.loud Coach>.
  var VOICE_ANY = /<v(?:\.[^\s>]+)*\s+([^>]{1,40})>/gi;
  // A line of a subtitle with two voices in it: "- Were you nervous?",
  // "- 500 a day.", or "-Were you nervous?" (no space, as professional
  // deliveries write it). Not a minus glued to a number ("-5 degrees"), and
  // not an en or em dash carrying a line on ("—and then my dad showed up").
  var DASH = /^\s*(?:[-‐‑](?:\s+|(?!\d))|[–—‒―](?:\s+|(?![\p{Ll}\d])))([^\s\-–—].*)$/u;
  var SPEAKER_N = /^\s*(speaker\s*\d{1,2})\s*$/i;
  // ">>" (">>>", "> >" and "»" too), a broadcast caption's mark for a new
  // speaker, at a line's start; ">>" also in the middle of one, where a
  // caption puts two turns on one line ("Every Sunday. >> Why Sunday?").
  var CHEVRON = /^\s*(?:>{2,}|(?:&gt;){2,}|>\s+>|»)\s*(.*)$/;
  var MID_CHEVRON = /\s*(?:>{2,}|(?:&gt;){2,}|>\s+>)/g;
  // A speaker named in brackets, as SDH subtitles write it ("[COACH] I ran
  // it", "(INTERVIEWER) Why?", "[man] Why that year?", "[crowd chanting]
  // Let's go!", "[INTERVIEWER, OFF-SCREEN]"): a voice. At a line's start, a
  // name in capitals is a label (in a file with no labels, a voice nobody
  // names); a person in lower case, or a name with more in it, is nobody's.
  // In the middle of a line ("Every Sunday. [INTERVIEWER] Why Sunday?") a
  // voice starts there too. Any other bracket is a note, and the voice goes
  // on: a sound ("[APPLAUSE]", "[whistle blows]"), how the speaker says it
  // ("[laughs nervously]", "(sighs)"), the language ("[in Spanish]"), the
  // editor's own ("[bleep]", "[sic]", "[2019]", "He told [Coach Hooks]"), or
  // words the transcript says are missing ("[inaudible]").
  var BRACKET = /^\s*[\[(]\s*([^\[\]()]{1,60}?)\s*[\])]\s*:?\s*(.*)$/u;
  var MID_BRACKET = /[\[(][^\[\]()]{1,60}[\])]/g;
  var MANNER = /^(?:(?:laugh|chuckl|giggl|sigh|scoff|snort|smirk|smil|grin|nod|shrug|winc|hum|mutter|mumbl|stammer|stutter|paus|hesitat|exhal|inhal|breath|snif|cough|gasp|groan|grunt|sob|whisper|yawn|clear|tear|sniffl)\w*|cr(?:y|ies|ying)|emotional|quietly|softly|beat|long|silence|voice (?:breaks|cracks|\p{L}+ing))(?:\s+[\p{L}'’-]+){0,3}$/iu;
  var LANGUAGE = /^(?:(?:in|speaking|speaks|speaking in)\s+)?(?:spanish|english|french|portuguese|creole|haitian creole|korean|vietnamese|tagalog|arabic|chinese|mandarin|cantonese|japanese|german|italian|russian|polish|hindi|samoan|tongan|swahili|somali|amharic|urdu|farsi|persian|hebrew|greek|turkish|ukrainian|asl|sign language)$/i;
  var EDITORIAL = /^(?:bleep\w*|beep\w*|censored|expletive\w*|sic|redacted|unclear|\?+|\.\.\.|…|[\d][\d,.:\s'’–-]*s?)$/i;
  var PERSON = /^(?:man|men|male|woman|women|female|boy|boys|girl|girls|kid|kids|child|children|teen|teens|guy|guys|lady|ladies|person|people|someone|somebody|voice|voices|reporter|interviewer|narrator|announcer|commentator|host|producer|director|crew|cameraman|camerawoman|crowd|audience|fan|fans|spectator|spectators|player|players|teammate|teammates|coach|coaches|trainer|captain|opponent|referee|ref|umpire|official|mom|mother|dad|father|parent|parents|brother|sister|son|daughter|husband|wife|aunt|uncle|cousin|grandma|grandpa|grandmother|grandfather|nana|papa|friend|student|students|teacher|everyone|group|tv|radio|pa|speaker|caller|offscreen|off-screen|off-camera|other|another|unidentified)$/i;
  // Roles a one-word bracket names ("[scout]", "[voice-over]"), besides
  // PERSON's: any other lower-case word that isn't a known sound, manner,
  // language or editor's note is read as a voice too (ROLE_LIKE).
  var ROLE_WORD = /^(?:scout|recruiter|agent|officer|police|cop|nurse|doctor|medic|paramedic|pastor|priest|preacher|minister|chaplain|manager|neighbor|neighbour|principal|counselor|counsellor|therapist|sheriff|deputy|judge|lawyer|dispatcher|operator|pilot|driver|guard|security|staff|staffer|assistant|volunteer|stranger|bystander|witness|journalist|anchor|analyst|interpreter|translator|boss|owner|clerk|cashier|waiter|waitress|voiceover|voice-over|narration|teammate)s?$/i;
  // One word that's a sound or a thing, not a voice.
  var SOUND_NOUN = /^(?:clatter\w*|shutter\w*|rumbl\w*|gunshots?|gunfire|explosions?|heartbeats?|fireworks?|traffic|echo\w*|feedback|ringtone|alarms?|chimes?|timer|motor|generator|water|waves?|birdsong|birds?|dogs?|crickets?|helicopter|plane|train|truck|cars?|phone|tv|radio)$/i;
  // The footage or the edit, not a voice ("[flashback]", "[slow motion]").
  var FRAME_NOTE = /^(?:flashback|archive|archival|montage|slow[- ]?mo(?:tion)?|replay|highlights?|intro|outro|title|titles|caption|captions|graphic|graphics|text|on[- ]?screen text|chyron|transition|cut|edit|b-?roll|phonetic|phonetically|sp|translated|translation|transcribed|continued|cont)$/i;
  function manner(s) {
    var t = String(s || "").trim();
    MISSING_RE.lastIndex = 0;
    return MANNER.test(t) || LANGUAGE.test(t) || EDITORIAL.test(t) || MISSING_RE.test("[" + t + "]");
  }
  // Whose bracket it is: "label" (a name in capitals or a label's words),
  // "person" (a voice named by who they are, or a name with more in it), or
  // "" (a note: the voice goes on).
  // How the speaker says it, to whom, or as whom: their own words go on
  // ("[to coach]", "[on phone with mom]", "[imitating his dad]").
  var ABOUT_SPEAKER = /^(?:to|toward|towards|at|with|as|on (?:the )?(?:phone|call)|(?:speaking|speaks|talking|talks|turning|turns|calling|calls|whispering|whispers|singing|sings|pointing|points|gesturing|gestures|nodding|nods|looking|looks|waving|waves) (?:to|at|toward|towards)|addressing|addresses|imitating|imitates|mimicking|mimics|mocking|mocks|impersonating|quoting|quotes|reading|reads)\b/i;
  // A sound people make in the background: the speaker's words go on
  // ("[players warming up]", "[kids playing in background]", "[radio
  // static]"), unless they're saying something ("[crowd chanting]").
  var BACKGROUND = /\b(?:playing|plays|warming up|practi[cs]ing|running|training|drilling|stretching|in (?:the )?background|noises?|static|murmur\w*|chatter\w*|indistinct\w*|laugh\w*|clapping|claps|applau\w*|footsteps|breathing|celebrating)\b/i;
  var SAYING = /\b(?:say\w*|said|shout\w*|yell\w*|chant\w*|call\w*|holler\w*|ask\w*|answer\w*|speak\w*|talk(?:s|ing)?(?! indistinct)|whisper\w*|scream\w*|reply\w*|repl(?:y|ies)|respond\w*|cheer\w*|counting|instruct\w*|sing\w*)\b/i;
  // Somebody else heard from afar ("[distant shouting]", "[muffled talking]").
  var DISTANT_VOICE = /^(?:distant|faint|far-off|faraway|muffled|background|unseen|off-?screen|off-?camera)\s+(?:shout|yell|call|holler|chant|talk|speak|scream|whisper|conversation|question|reply|answer)\w*$/i;
  function voiceOf(inside) {
    var t = String(inside || "").trim().replace(/\s+/g, " ");
    if (!t || manner(t) || FRAME_NOTE.test(t)) return "";
    if (ABOUT_SPEAKER.test(t)) return "";
    var words = t.split(/[\s,]+/).map(function (w) { return w.replace(/['’]s$/i, ""); });
    var person = words.some(function (w) { return PERSON.test(w) || ROLE_WORD.test(w); }) || /\boff[\s-]?(?:camera|screen|mic)\b/i.test(t);
    // Written like a name ("COACH", "Coach Hooks", "Mrs Lopez"): a label.
    if (/^\p{L}/u.test(t) && LABEL_LIKE.test(t) && (PERSON.test(words[0]) || ROLE_WORD.test(words[0]) || !soundNote(t))) return "label";
    if (person && BACKGROUND.test(t) && !SAYING.test(t)) return "";
    // Who they are, in lower case or with more ("man", "male voice",
    // "woman's voice", "crowd chanting", "grandma", "off camera", "scout",
    // "INTERVIEWER, OFF-SCREEN"): a voice nobody names.
    if (person || DISTANT_VOICE.test(t)) return "person";
    // One lower-case word that isn't a sound, a thing, an action ("-ing",
    // "-ed", "-s") or a manner ("-ly"): someone ("[recruiter]", "[nurse]").
    if (/^\p{Ll}[\p{Ll}-]{1,24}$/u.test(t) && !soundNote(t) && !SOUND_NOUN.test(t) && !/(?:ing|ed|ly|s)$/.test(t)) return "person";
    return "";
  }
  // A line cut where another voice starts in the middle of it: at ">>", at a
  // voice in brackets (a name in capitals or a person anywhere; a name
  // written like a name only after a sentence's end, not "He told [Coach
  // Hooks]"), and at a label in capitals after a sentence's end ("Every
  // Sunday. INTERVIEWER: Why Sunday?"). Never right after a label of the
  // line's own ("COACH: [chuckles softly] Every Sunday").
  var MID_LABEL = /([.!?…]["”’)]?)\s+(?=[\p{Lu}][\p{Lu}\p{M}\p{N} .'’-]{1,38}?\s*(?:\([^()]{1,20}\))?\s*:\s)/gu;
  function cutLine(raw) {
    var cuts = [];
    var m;
    // A line that starts in italics and goes on: the italics are a line of
    // their own ("<i>Why that year?</i> Because nobody filmed it.").
    // Only where the italics end a sentence or a new one starts after them:
    // a word in italics for stress ("<i>Never</i> again, I said.") stays.
    var lead = /^\s*<i>([\s\S]*?)<\/i>/i.exec(raw);
    if (lead) {
      var rest = raw.slice(lead[0].length);
      var inner = lead[1].replace(/<[^>]*>/g, "").trim();
      var ends = /[.!?…]["”’)]?$/.test(inner);
      var fresh = /^\s*["“]?\p{Lu}/u.test(rest) && /\s/.test(inner);
      if (/\S/.test(rest) && (ends || fresh)) cuts.push(lead[0].length);
    }
    var labelOnly = function (before) { return /^\s*(?:[-‐‑–—]\s*|>{2,}\s*)?[^:\s][^:]{0,40}:\s*$/u.test(before); };
    MID_CHEVRON.lastIndex = 0;
    while ((m = MID_CHEVRON.exec(raw))) if (/\S/.test(raw.slice(0, m.index))) cuts.push(m.index);
    MID_BRACKET.lastIndex = 0;
    while ((m = MID_BRACKET.exec(raw))) {
      var before = raw.slice(0, m.index);
      // Part of a label ("INTERVIEWER (O.S.): Why?"), or right after one.
      if (!/\S/.test(before) || labelOnly(before) || /^\s*:/.test(raw.slice(m.index + m[0].length))) continue;
      var inside = m[0].slice(1, -1);
      var who = voiceOf(inside);
      if (!who) continue;
      var afterSentence = /[.!?…]["”’)]?\s*$/.test(before);
      var caps = /^[\p{Lu}\p{M}\p{N} .,'’-]+$/u.test(inside.trim());
      // A person in the middle of a sentence that goes on in lower case is
      // in the background ("We did it [crowd cheering] every one of us").
      var goesOn = !afterSentence && /^\s*\p{Ll}/u.test(raw.slice(m.index + m[0].length));
      if ((who === "person" && !goesOn) || caps || afterSentence) cuts.push(m.index);
    }
    MID_LABEL.lastIndex = 0;
    while ((m = MID_LABEL.exec(raw))) {
      var at = m.index + m[0].length;
      var name = raw.slice(at).split(":")[0].replace(/\([^()]*\)/, "").trim();
      if (LABEL_LIKE.test(name) && !NOT_LABEL.test(name) && !SPEECH.test(name)) cuts.push(at);
    }
    cuts.sort(function (a, b) { return a - b; });
    var out = [];
    var at0 = 0;
    cuts.forEach(function (c) { if (c > at0) { out.push(raw.slice(at0, c)); at0 = c; } });
    out.push(raw.slice(at0));
    return out.filter(function (x) { return x.trim(); });
  }
  var SOUND_FIRST = /^(?:music|musical|song|applause|applauding|laugh\w*|chuckl\w*|giggl\w*|sigh\w*|cheer\w*|clap\w*|whistl\w*|silence|silent|quiet|pause|noise|static|beep\w*|buzz\w*|horn\w*|bell\w*|ring\w*|footstep\w*|breath\w*|exhal\w*|inhal\w*|pant\w*|gasp\w*|cough\w*|snif\w*|cr(?:y|ies|ying)|sob\w*|scream\w*|shout\w*|yell\w*|groan\w*|grunt\w*|moan\w*|wind|rain|thunder\w*|engine\w*|door\w*|knock\w*|bounc\w*|indistinct|chatter\w*|crosstalk|inaudible|unintelligible|overlapping|upbeat|dramatic|soft|loud|distant|muffled|siren\w*|whoosh\w*|thud\w*|bang\w*|splash\w*|crash\w*|click\w*|typing|murmur\w*|whisper\w*|sing\w*|hum\w*|chant\w*|speak\w*|background|sound\w*|sfx|ball|game|play|plays|beat|beats|bass|drums?|guitar|piano)$/i;
  var SOUND_LAST = /(?:ing|blows|rings|closes|opens|slams|buzzes|beeps|honks|roars|cheers|claps|laughs|sighs|barks|chirps|ticks|plays|starts|stops|continues|fades|rises|swells|builds|ends|drops|bounces|squeaks)$/i;
  function soundNote(s) {
    var w = String(s || "").trim().toLowerCase().split(/\s+/);
    MISSING_RE.lastIndex = 0;
    if (MISSING_RE.test("[" + s + "]")) return true;
    if (SOUND_FIRST.test(w[0])) return true;
    return w.length > 1 && SOUND_LAST.test(w[w.length - 1]);
  }

  // One subtitle's lines, split where the voice changes: a voice tag, a
  // "Speaker 1" line, a typed label, a name in brackets, a "- " line, a ">>"
  // line. Each part: { kind, who, text } (kind null: no mark, the voice goes
  // on from before). A subtitle with a dashed or a ">>" line in it has two
  // voices: its parts with no tag or label of their own are nobody's (kind
  // "dash"); a ">>" line with no label is a new voice nobody names ("chev").
  function partsOf(given) {
    var out = [];
    var cur = null;
    function begin(kind, who) { cur = { kind: kind, who: who, text: [] }; out.push(cur); }
    // Each piece of a line cut where another voice may start is a line of its
    // own; the first piece of the subtitle's first line starts it.
    var lines = [];
    var first = [];
    given.forEach(function (raw, li) {
      // Italics as converted subtitles keep them ({\i1}…{\i0}).
      var r = String(raw).replace(/\{\\i1\}/gi, "<i>").replace(/\{\\i0\}/gi, "</i>");
      cutLine(r).forEach(function (piece, k) { lines.push(piece); first.push(li === 0 && k === 0); });
    });
    // A line all in italics ("<i>Why that year?</i>"), as subtitles mark an
    // off-screen voice (sometimes the speaker's own voice-over), and a sung
    // line ("♪ We are the champions ♪"): nobody's.
    var italic = false;
    lines.forEach(function (raw, idx) {
      var tr = raw.trim();
      var opens = /^<i>/i.test(tr);
      var whole = (opens || italic) && (/<\/i>$/i.test(tr) || !/<\/i>/i.test(tr)) && !/<\/i>.*\S/i.test(tr.replace(/<\/i>$/i, "")) ;
      if (opens && !/<\/i>/i.test(tr)) italic = true;
      else if (/<\/i>/i.test(tr)) italic = false;
      // Sung: a note at either end, or wrapped in # as some subtitles mark it.
      if (whole || /^[♪♫]|[♪♫]$/.test(tr) || /^#\s.*\s#$/.test(tr)) {
        if (!(cur && cur.kind === "other" && cur.sung)) { begin("other", ""); cur.sung = true; }
        cur.text.push(raw);
        return;
      }
      if (cur && cur.sung) cur = null;
      // Split the line at each voice tag.
      var segs = [];
      var at = 0;
      var m;
      VOICE_ANY.lastIndex = 0;
      while ((m = VOICE_ANY.exec(raw))) {
        segs.push({ who: null, text: raw.slice(at, m.index) });
        segs.push({ who: cleanText(m[1]) || "?", text: "" });
        at = m.index + m[0].length;
      }
      segs.push({ who: null, text: raw.slice(at) });
      segs.forEach(function (seg, k) {
        if (seg.who) {
          // The voice's words are the segment after the tag.
          begin("voice", seg.who);
          return;
        }
        var t = seg.text;
        if (!t.trim()) return;
        if (k === 0) {
          // Only a whole line (or what comes before a tag) can start with a
          // mark of its own.
          if (SPEAKER_N.test(t) && idx < lines.length - 1) { begin("speaker", SPEAKER_N.exec(t)[1].replace(/\s+/g, " ").replace(/^speaker/i, "Speaker")); return; }
          var chev = CHEVRON.exec(t);
          var t0 = chev ? chev[1] : t;
          var dash = chev ? null : DASH.exec(t0);
          var body = dash ? dash[1] : t0;
          // A voice changes here: a ">>" or a dashed line starts its subtitle's
          // own voice, and so does a subtitle's first line.
          var starts = first[idx] || !!dash || !!chev;
          var br = BRACKET.exec(body);
          var bw = br ? voiceOf(br[1]) : "";
          if (bw) {
            // A name in brackets: a label (in a file with no labels, a voice
            // nobody names: nobody's). A person in lower case, or a name with
            // more in it: nobody's. A note ("[whistle blows]", "[laughs
            // nervously]") isn't a voice: the voice goes on.
            if (bw === "label") {
              begin("label", br[1].trim().replace(/\s+/g, " ")); cur.dash = !!dash; cur.chev = !!chev; cur.br = true; cur.odd = false; cur.start = starts;
            } else {
              begin("other", ""); cur.dash = !!dash; cur.chev = !!chev;
            }
            if (br[2].trim()) cur.text.push(br[2]);
            return;
          }
          var lab = LABEL.exec(body);
          var name = lab ? lab[1].trim() : "";
          var like = !!lab && LABEL_LIKE.test(name) && (starts || !NOT_LABEL.test(name));
          if (lab && !SPEECH.test(name) && (starts || like)) { begin("label", name); cur.dash = !!dash; cur.chev = !!chev; cur.odd = !like; cur.start = starts; cur.text.push(lab[2]); return; }
          if (chev) { begin("chev", ""); if (body.trim()) cur.text.push(body); return; }
          if (dash) { begin("dash", ""); cur.text.push(body); return; }
        }
        if (!cur) begin(null, undefined);
        cur.text.push(t);
      });
    });
    if (out.some(function (pt) { return pt.kind === "dash" || pt.dash || pt.kind === "chev" || pt.chev; })) {
      out.forEach(function (pt) { if (pt.kind === null) { pt.kind = "dash"; pt.who = ""; } });
    }
    return out;
  }

  function parse(text, opts) {
    var fps = opts && FPS.indexOf(Number(opts.fps)) >= 0 ? Number(opts.fps) : null;
    var src = String(text || "").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
    if (!src.trim()) return { ok: false, error: "empty" };
    var lines = src.split("\n");
    var drop = /\d{1,2}:\d{2}:\d{2};\d{2}/.test(src);
    var raw = []; // { s, e (or null), lines: [] }
    var format = /^\s*WEBVTT\b/.test(lines[0]) ? "vtt" : null;
    var frames = false;
    var i;
    if (lines.some(function (l) { return ARROW.test(l); })) {
      format = format || "srt";
      for (i = 0; i < lines.length; i++) {
        var m = ARROW.exec(lines[i]);
        if (!m) continue;
        var a = msOf(m[1], fps), b = msOf(m[2], fps);
        if (!a || !b) continue;
        if (a.frames || b.frames) frames = true;
        var cue = { s: a.ms, e: b.ms, lines: [] };
        for (i = i + 1; i < lines.length && lines[i].trim() !== ""; i++) {
          if (ARROW.test(lines[i])) { i--; break; }
          cue.lines.push(lines[i]);
        }
        raw.push(cue);
      }
    } else {
      format = "timecodes";
      var cur = null;
      for (i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (!line.trim()) continue;
        var t = LEAD_TC.exec(line);
        if (t) {
          var start = msOf(t[1], fps);
          var end = t[2] ? msOf(t[2], fps) : null;
          if (start) {
            if (start.frames || (end && end.frames)) frames = true;
            cur = { s: start.ms, e: end ? end.ms : null, lines: [] };
            raw.push(cur);
            var rest = t[3];
            if (rest && rest.trim()) cur.lines.push(rest);
            continue;
          }
        }
        if (cur) cur.lines.push(line);
      }
    }
    if (frames && !fps) return { ok: false, error: "needs_fps", format: format, frames: true };
    if (!raw.length) return { ok: false, error: "no_timecodes", format: format };
    // A cue with no end ends where the next one starts (the last, 3 s on).
    for (i = 0; i < raw.length; i++) {
      if (raw[i].e == null) raw[i].e = i + 1 < raw.length ? Math.max(raw[i].s, raw[i + 1].s) : raw[i].s + 3000;
    }
    // Speakers: a voice tag, "Speaker 1" on its own line, or a typed label
    // ("Coach:"). A label typed only once in a file with no other labels is
    // more likely someone saying "Listen: ...". A subtitle with more than one
    // voice or label is split into one part for each, its time shared out by
    // their words. A part with no mark is the voice before it's.
    var counts = {};
    var split = [];
    raw.forEach(function (c) {
      var ps = partsOf(c.lines).map(function (pt) { return { kind: pt.kind, who: pt.who, dash: !!pt.dash, chev: !!pt.chev, br: !!pt.br, odd: !!pt.odd, text: pt.text.join(" ") }; })
        .filter(function (pt) { return /[\p{L}\p{N}]/u.test(cleanText(pt.text)); });
      if (!ps.length) return;
      ps.forEach(function (pt) {
        if (pt.kind === "voice" || pt.kind === "speaker") counts[pt.who] = (counts[pt.who] || 0) + 1;
        // Only what looks like a label makes the file a labelled one.
        if (pt.kind === "label" && !pt.odd) counts["?" + pt.who] = (counts["?" + pt.who] || 0) + 1;
      });
      // The subtitle's time, shared by how many words each part has.
      var n = ps.map(function (pt) { return Math.max(1, (cleanText(pt.text).match(/[\p{L}\p{N}]+/gu) || []).length); });
      var all = n.reduce(function (a, b) { return a + b; }, 0);
      var acc = 0;
      ps.forEach(function (pt, k) {
        var a = c.s == null ? null : Math.round(c.s + ((c.e - c.s) * acc) / all);
        acc += n[k];
        var b = c.s == null ? null : k === ps.length - 1 ? c.e : Math.round(c.s + ((c.e - c.s) * acc) / all);
        split.push({ s: a, e: b, kind: pt.kind, who: pt.who, dash: pt.dash, chev: pt.chev, br: pt.br, odd: pt.odd, text: pt.text, sub: ps.length > 1 });
      });
    });
    // Once the file uses labels (a voice tag, "Speaker 1", or any typed label
    // used twice), every typed label counts: an interviewer asking once is
    // still the interviewer, not the speaker. In such a file a line with no
    // label before any label is a voice the file doesn't name (""). Nobody's
    // (TWO): a dashed or ">>" subtitle's parts with no label of their own,
    // words before a colon that don't look like a label, and, in a file with
    // labels, what follows them with no label until the next one (whose it
    // is isn't known). A ">>" file with no labels is nobody's throughout: its
    // voices change at every ">>" and none is named.
    var labelled = Object.keys(counts).some(function (k) { return k.charAt(0) !== "?" || counts[k] >= 2; });
    var chevrons = split.some(function (p) { return p.kind === "chev" || p.chev; });
    var last = labelled ? "" : null;
    var cues = [];
    var total = 0;
    var mixed = 0;
    var late = 0;
    for (i = 0; i < split.length; i++) {
      var p = split[i];
      var who;
      if (p.kind === "voice" || p.kind === "speaker") who = p.who;
      else if (p.kind === "label") {
        if (labelled && p.odd) { p.text = p.who + ": " + p.text; who = TWO; }
        else if (labelled) who = p.who;
        else if (p.br) who = TWO;
        // Written once in a file with no labels: a label that looks like one
        // ("Producer: Why that year?") is another voice; "Listen: …" is words.
        else { p.text = p.who + ": " + p.text; who = p.dash || p.chev || (!p.odd && !NOT_LABEL.test(p.who) && !ONCE_WORDS.test(p.who.split(/\s+/)[0])) ? TWO : last; }
      } else if (p.kind === "dash" || p.kind === "chev" || p.kind === "other") who = TWO;
      else who = last;
      if (!labelled && chevrons) who = TWO;
      // In a file with labels, what follows nobody's with no label is
      // nobody's too; in one without, the file's voice goes on.
      if (who === TWO) {
        mixed++;
        if (labelled) last = TWO;
      } else last = who;
      var tx = cleanText(p.text);
      if (!tx || !/[\p{L}\p{N}]/u.test(tx)) continue;
      if (p.s != null && p.e != null && p.e > MAX_MS) { late++; continue; }
      if (p.s == null || p.e == null || p.s < 0 || p.e < p.s) continue;
      if (tx.length > MAX_CUE) return { ok: false, error: "cue_too_long", at: cues.length + 1 };
      total += tx.length;
      cues.push({ n: cues.length + 1, s: p.s, e: p.e, t: tx, who: who === undefined ? null : who });
    }
    if (late) return { ok: false, error: "past_ten_hours", format: format, late: late };
    if (!cues.length) return { ok: false, error: "no_words", format: format };
    if (cues.length > MAX_CUES) return { ok: false, error: "too_many_cues", max: MAX_CUES };
    if (total > MAX_TOTAL) return { ok: false, error: "too_long", max: MAX_TOTAL };
    var seen = {};
    var speakers = [];
    cues.forEach(function (c) {
      if (c.who === TWO) return;
      var k = c.who === null ? "\u0000all" : "=" + c.who;
      if (!(k in seen)) { seen[k] = speakers.length; speakers.push({ who: c.who, cues: 0 }); }
      speakers[seen[k]].cues++;
    });
    // The brackets read as notes, not voices (the speaker's voice goes on
    // past them), for the editor to check: "[whistle blows]", "[laughs]".
    var notes = [];
    raw.forEach(function (c) {
      c.lines.forEach(function (l) {
        var m;
        var re = /[\[(]([^\[\]()]{1,60})[\])]/g;
        while ((m = re.exec(l)) && notes.length < 12) {
          var t = m[1].trim().replace(/\s+/g, " ");
          MISSING_RE.lastIndex = 0;
          if (t && !voiceOf(t) && !MISSING_RE.test("[" + t + "]") && !/^(?:o\.?\s?s\.?|v\.?\s?o\.?|cont['’]?d\.?)$/i.test(t) && notes.indexOf(t.toLowerCase()) < 0) notes.push(t.toLowerCase());
        }
      });
    });
    return { ok: true, format: format, frames: frames, fps: frames ? fps : null, drop: frames && drop, cues: cues, speakers: speakers, labelled: labelled, mixed: mixed, voices: speakers.length, notes: notes };
  }

  // A speaker's cues, numbered again from 1. A cue that comes after someone
  // else's (a question, another voice) is marked gap: a line never reaches
  // back across it. Unless the file names two voices or more (pauses:
  // false), so is one after a pause of more than three seconds: a question
  // cut out of the file leaves one. who null: a file with no labels (its
  // lines with no other voice in them). pausesFor(parsed) says which.
  function only(cues, who, opts) {
    var pauses = !(opts && opts.pauses === false);
    var out = [];
    var prevIdx = -2;
    if (who === TWO) return out;
    (cues || []).forEach(function (c, idx) {
      if (c.who !== (who === undefined ? null : who)) return;
      var x = { n: out.length + 1, s: c.s, e: c.e, t: c.t };
      var prev = out[out.length - 1];
      if (prev && (idx !== prevIdx + 1 || (pauses && c.s - prev.e > PAUSE_MS))) x.gap = true;
      out.push(x);
      prevIdx = idx;
    });
    return out;
  }

  // Words for matching: letters and numbers, an apostrophe inside a word
  // kept ("don't"), case and curly quotes set aside.
  var WORD = /[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*/gu;
  function tokens(s) {
    var out = [];
    var m;
    WORD.lastIndex = 0;
    while ((m = WORD.exec(s))) out.push({ w: m[0].normalize("NFC").toLowerCase().replace(/’/g, "'"), a: m.index, b: m.index + m[0].length });
    return out;
  }

  // The quote, found word for word in cues from..to (their numbers), given
  // back as those cues have it: the exact words, the cues they're in, and
  // when they start and end (in between a cue's times, by how far into it
  // the words are). A line spans at most 12 cues.
  function find(cues, from, to, quote) {
    var list = cues || [];
    from = Math.floor(Number(from));
    to = Math.floor(Number(to));
    if (!(from >= 1) || !(to >= from) || to > list.length) return { ok: false, why: "cues" };
    if (to - from > 11) return { ok: false, why: "too_many_cues" };
    var range = list.slice(from - 1, to);
    var joined = "";
    var spans = [];
    range.forEach(function (c, k) {
      if (k) joined += " ";
      spans.push({ a: joined.length, b: joined.length + c.t.length, c: c });
      joined += c.t;
    });
    var hay = tokens(joined);
    var q = tokens(String(quote || ""));
    if (!q.length) return { ok: false, why: "empty" };
    var hits = [];
    for (var i = 0; i + q.length <= hay.length; i++) {
      var j = 0;
      while (j < q.length && hay[i + j].w === q[j].w) j++;
      if (j === q.length) hits.push(i);
    }
    if (!hits.length) return { ok: false, why: "not_verbatim" };
    // A line starts and ends on whole words: not inside "4.4", "1,000",
    // "5:30", "can‘t" (or "can´t", "can′t"), "well-known" or "1990–95". The
    // first match that does is the one (the database reads the same:
    // studio_quote_whole).
    var JOIN = /[.,'’‘`´′ʼ＇:\-\/\u2010-\u2015]/;
    var WORDCH = /[\p{L}\p{M}\p{N}]/u;
    var whole = hits.filter(function (h) {
      var f = hay[h], l = hay[h + q.length - 1];
      return !((f.a >= 2 && JOIN.test(joined.charAt(f.a - 1)) && WORDCH.test(joined.charAt(f.a - 2))) ||
        (JOIN.test(joined.charAt(l.b)) && WORDCH.test(joined.charAt(l.b + 1))));
    });
    if (!whole.length) return { ok: false, why: "part_of_a_word" };
    hits = whole;
    var at = hits[0];
    var first = hay[at], lastT = hay[at + q.length - 1];
    // Nor across words the transcript marks as missing.
    if (joined.slice(first.a, lastT.b).indexOf(MISSING) >= 0) return { ok: false, why: "missing_words" };
    function cueOf(tok) {
      for (var k = 0; k < spans.length; k++) if (tok.a >= spans[k].a && tok.a < spans[k].b) return k;
      return spans.length - 1;
    }
    // A word's place in its cue, as a share of the cue's words.
    function when(tok, endOf) {
      var k = cueOf(tok);
      var sp = spans[k];
      var inCue = hay.filter(function (x) { return x.a >= sp.a && x.a < sp.b; });
      var idx = inCue.indexOf(tok);
      var share = (idx + (endOf ? 1 : 0)) / Math.max(1, inCue.length);
      return Math.round(sp.c.s + (sp.c.e - sp.c.s) * share);
    }
    var kFrom = cueOf(first), kTo = cueOf(lastT);
    // Said more than once in these cues, in different cues: which one is
    // meant isn't clear (its times would be the first one's).
    if (hits.some(function (h) { return cueOf(hay[h]) !== kFrom; })) return { ok: false, why: "said_twice" };
    // Nor across someone else's words (a question), or a long pause.
    for (var g = kFrom + 1; g <= kTo; g++) if (range[g].gap) return { ok: false, why: "across_a_gap" };
    return {
      ok: true,
      quote: joined.slice(first.a, lastT.b),
      from: range[kFrom].n,
      to: range[kTo].n,
      s: when(first, false),
      e: when(lastT, true),
      words: q.length,
    };
  }

  function pad(n, w) { n = String(n); while (n.length < (w || 2)) n = "0" + n; return n; }
  // A time as a timecode: to the frame (rounded, carried into the second)
  // for a frame-based transcript, ";" before the frames when it's drop-frame;
  // otherwise to the tenth of a second.
  function tc(ms, opts) {
    ms = Math.max(0, Math.round(Number(ms) || 0));
    var secs = Math.floor(ms / 1000);
    var tail;
    if (opts && opts.frames && opts.fps) {
      var nominal = Math.round(opts.fps);
      var f = Math.round(((ms % 1000) / 1000) * opts.fps);
      if (f >= nominal) { f = 0; secs += 1; }
      // Drop-frame skips the first frame numbers of every minute but each
      // tenth (2 at 29.97, 4 at 59.94): those labels never show.
      if (opts.drop) {
        var skip = Math.round(opts.fps * 0.066666);
        if (secs % 60 === 0 && Math.floor(secs / 60) % 10 !== 0 && f < skip) f = skip;
      }
      tail = (opts.drop ? ";" : ":") + pad(f);
    } else tail = "." + Math.floor((ms % 1000) / 100);
    var h = Math.floor(secs / 3600), m = Math.floor(secs / 60) % 60, s = secs % 60;
    return pad(h) + ":" + pad(m) + ":" + pad(s) + tail;
  }

  // Whether a pause is a gap for this file: unless it names two voices or
  // more (a file whose only label is the speaker's may have had its
  // questions cut out).
  function pausesFor(r) { return !(r && r.labelled && r.voices >= 2); }

  return { parse: parse, only: only, pausesFor: pausesFor, find: find, tokens: tokens, tc: tc, FPS: FPS, MAX_CUES: MAX_CUES, MAX_CUE: MAX_CUE, MAX_TOTAL: MAX_TOTAL, MAX_MS: MAX_MS, MISSING: MISSING, PAUSE_MS: PAUSE_MS, TWO: TWO };
});
