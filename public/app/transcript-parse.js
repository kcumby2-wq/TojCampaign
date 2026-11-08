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
 * who: a speaker's label; "" for a line whose voice the file doesn't say
 * (no label in a file that has labels); TWO for a part of a subtitle with
 * two voices in it ("- " or "-" lines) that has no label or tag of its own:
 * nobody's, never picked, counted in mixed; null only in a file with no
 * labels at all. A subtitle with two voices or two labels in it is split
 * into one cue for each.
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
  var LABEL = /^\s*(\p{L}[\p{L}\p{M}\p{N} .'’-]{0,38}?)\s*:\s+(\S.*)$/u;
  // What a label looks like: all capitals, "Speaker 2", or one to three words
  // each with a capital ("Coach", "Pat R.", "Mrs Lopez"). Anything else
  // before a colon is a label only in a file that has labels, and then a
  // voice the file doesn't say ("").
  var LABEL_LIKE = /^(?:speaker\s*\d{1,2}|[\p{Lu}\p{M}\p{N} .'’-]+|\p{Lu}[\p{L}\p{M}.'’-]*(?:\s+\p{Lu}[\p{L}\p{M}.'’-]*){0,2})$/u;
  // Someone quoting someone ("He said: ..."): never a label.
  var SPEECH = /\b(?:said|says|say|asked|asks|ask|told|tells|tell|replied|replies|added|adds|explained|explains|yelled|yells|shouted|shouts|whispered|goes|went)\b/i;
  // A part of a subtitle with two voices in it and no label of its own.
  var TWO = "\u0000two";
  // A voice tag, anywhere in a line: <v Coach>, <v.loud Coach>.
  var VOICE_ANY = /<v(?:\.[^\s>]+)*\s+([^>]{1,40})>/gi;
  // A line of a subtitle with two voices in it: "- Were you nervous?", or
  // "-Were you nervous?" (no space, as professional deliveries write it).
  var DASH = /^\s*[-–—‐‑‒―]\s*([^\s\-–—].*)$/;
  var SPEAKER_N = /^\s*(speaker\s*\d{1,2})\s*$/i;

  // One subtitle's lines, split where the voice changes: a voice tag, a
  // "Speaker 1" line, a typed label, a "- " line. Each part: { kind, who,
  // text } (kind null: no mark, the voice goes on from before). A subtitle
  // with a dashed line in it has two voices: its parts with no tag or label
  // of their own are nobody's (kind "dash").
  function partsOf(lines) {
    var out = [];
    var cur = null;
    function begin(kind, who) { cur = { kind: kind, who: who, text: [] }; out.push(cur); }
    lines.forEach(function (raw, idx) {
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
          var dash = DASH.exec(t);
          var body = dash ? dash[1] : t;
          var lab = LABEL.exec(body);
          var name = lab ? lab[1].trim() : "";
          var like = !!lab && LABEL_LIKE.test(name);
          if (lab && !SPEECH.test(name) && (idx === 0 || dash || like)) { begin("label", name); cur.dash = !!dash; cur.odd = !like; cur.text.push(lab[2]); return; }
          if (dash) { begin("dash", ""); cur.text.push(body); return; }
        }
        if (!cur) begin(null, undefined);
        cur.text.push(t);
      });
    });
    if (out.some(function (pt) { return pt.kind === "dash" || pt.dash; })) {
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
      var ps = partsOf(c.lines).map(function (pt) { return { kind: pt.kind, who: pt.who, dash: !!pt.dash, odd: !!pt.odd, text: pt.text.join(" ") }; })
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
        split.push({ s: a, e: b, kind: pt.kind, who: pt.who, dash: pt.dash, odd: pt.odd, text: pt.text, sub: ps.length > 1 });
      });
    });
    // Once the file uses labels (a voice tag, "Speaker 1", or any typed label
    // used twice), every typed label counts: an interviewer asking once is
    // still the interviewer, not the speaker. In such a file a line with no
    // label before any label is a voice the file doesn't name (""), and so is
    // one after a colon that doesn't look like a label. A dashed subtitle's
    // parts with no label of their own are nobody's (TWO).
    var labelled = Object.keys(counts).some(function (k) { return k.charAt(0) !== "?" || counts[k] >= 2; });
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
        if (labelled && p.odd) { p.text = p.who + ": " + p.text; who = ""; }
        else if (labelled) who = p.who;
        else { p.text = p.who + ": " + p.text; who = p.dash ? TWO : last; }
      } else if (p.kind === "dash") who = TWO;
      else who = last;
      // A part of a two-voice subtitle with no label of its own: kept out of
      // everyone's words. In a file with labels, what follows it with no
      // label is a voice the file doesn't name; in one without, the file's
      // voice goes on.
      if (who === TWO) {
        mixed++;
        if (labelled) last = "";
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
    return { ok: true, format: format, frames: frames, fps: frames ? fps : null, drop: frames && drop, cues: cues, speakers: speakers, labelled: labelled, mixed: mixed };
  }

  // A speaker's cues, numbered again from 1. A cue that comes after someone
  // else's (a question, another voice) is marked gap: a line never reaches
  // back across it. In a file with no labels (pauses), so is one after a
  // pause of more than three seconds: a question cut out of the file leaves
  // one. who null: a file with no labels (its lines with no other voice in
  // them).
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

  return { parse: parse, only: only, find: find, tokens: tokens, tc: tc, FPS: FPS, MAX_CUES: MAX_CUES, MAX_CUE: MAX_CUE, MAX_TOTAL: MAX_TOTAL, MAX_MS: MAX_MS, MISSING: MISSING, PAUSE_MS: PAUSE_MS, TWO: TWO };
});
