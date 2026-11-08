/* Transcripts from DaVinci Resolve (and most editors): SubRip (.srt),
 * WebVTT (.vtt), or plain text with a timecode on or above each line.
 *
 * Read in the browser: only the words of the speaker picked go to the
 * server, so the interviewer's questions and anyone else's words never leave
 * the computer. The server keeps nothing it can't check with this same code
 * (utils/studio-words.js requires this file).
 *
 *   parse(text, { fps })          → { ok, format, frames, cues: [{ n, s, e, t, who }], speakers: [{ who, cues }], error }
 *   only(cues, who)               → that speaker's cues (all of them when who is null), numbered again from 1
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

  // What a line of a cue says: tags, positions, sound notes and music out.
  function cleanText(s) {
    return String(s || "")
      .replace(/\{\\[^}]*\}/g, " ")
      .replace(/<\/?(?:i|b|u|c|font|ruby|rt|lang|span)\b[^>]*>/gi, "")
      .replace(/<\d{1,2}:\d{2}[^>]*>/g, "")
      .replace(/\[[^\]]{0,60}\]/g, " ")
      .replace(/[♪♫]+/g, " ")
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  // A speaker's label the editor typed: "Speaker 1:", "COACH:", "Pat R.:".
  var LABEL = /^\s*(?:-\s*)?([A-Za-z][A-Za-z0-9 .'’-]{0,38}?)\s*:\s+(\S.*)$/;
  var VOICE = /^\s*<v(?:\.[^\s>]+)*\s+([^>]{1,40})>\s*(.*)$/i;

  function parse(text, opts) {
    var fps = opts && FPS.indexOf(Number(opts.fps)) >= 0 ? Number(opts.fps) : null;
    var src = String(text || "").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
    if (!src.trim()) return { ok: false, error: "empty" };
    var lines = src.split("\n");
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
    // more likely someone saying "Listen: ...". A cue with no label is the
    // last speaker's.
    var counts = {};
    var parts = raw.map(function (c) {
      var who = null;
      var body = [];
      var firstLine = true;
      c.lines.forEach(function (l) {
        var v = VOICE.exec(l);
        if (v) { who = cleanText(v[1]); l = v[2]; }
        else if (firstLine) {
          var sp = /^\s*(speaker\s*\d{1,2}|SPEAKER\s*\d{1,2})\s*$/i.exec(l);
          if (sp && c.lines.length > 1) { who = sp[1].replace(/\s+/g, " ").replace(/^speaker/i, "Speaker"); firstLine = false; return; }
          var lab = LABEL.exec(l);
          if (lab) { who = "?" + lab[1].trim(); l = lab[2]; }
        }
        firstLine = false;
        body.push(l);
      });
      if (who) counts[who] = (counts[who] || 0) + 1;
      return { s: c.s, e: c.e, who: who, text: body.join(" ") };
    });
    // Once the file uses labels (a voice tag, "Speaker 1", or any typed label
    // used twice), every typed label counts: an interviewer asking once is
    // still the interviewer, not the speaker.
    var labelled = Object.keys(counts).some(function (k) { return k.charAt(0) !== "?" || counts[k] >= 2; });
    var last = null;
    var cues = [];
    var total = 0;
    for (i = 0; i < parts.length; i++) {
      var p = parts[i];
      var who = p.who;
      if (who && who.charAt(0) === "?") {
        if (labelled) who = who.slice(1);
        else { p.text = who.slice(1) + ": " + p.text; who = null; }
      }
      if (who) last = who;
      else who = last;
      var tx = cleanText(p.text);
      if (!tx || !/[\p{L}\p{N}]/u.test(tx)) continue;
      if (p.s == null || p.e == null || p.s < 0 || p.e < p.s || p.e > MAX_MS) continue;
      if (tx.length > MAX_CUE) return { ok: false, error: "cue_too_long", at: cues.length + 1 };
      total += tx.length;
      cues.push({ n: cues.length + 1, s: p.s, e: p.e, t: tx, who: who || null });
    }
    if (!cues.length) return { ok: false, error: "no_words", format: format };
    if (cues.length > MAX_CUES) return { ok: false, error: "too_many_cues", max: MAX_CUES };
    if (total > MAX_TOTAL) return { ok: false, error: "too_long", max: MAX_TOTAL };
    var seen = {};
    var speakers = [];
    cues.forEach(function (c) {
      var k = c.who || "";
      if (!(k in seen)) { seen[k] = speakers.length; speakers.push({ who: c.who, cues: 0 }); }
      speakers[seen[k]].cues++;
    });
    return { ok: true, format: format, frames: frames, fps: frames ? fps : null, cues: cues, speakers: speakers };
  }

  function only(cues, who) {
    return (cues || []).filter(function (c) { return who == null || c.who === who; }).map(function (c, k) { return { n: k + 1, s: c.s, e: c.e, t: c.t }; });
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
    var at = -1;
    for (var i = 0; i + q.length <= hay.length && at < 0; i++) {
      var j = 0;
      while (j < q.length && hay[i + j].w === q[j].w) j++;
      if (j === q.length) at = i;
    }
    if (at < 0) return { ok: false, why: "not_verbatim" };
    var first = hay[at], lastT = hay[at + q.length - 1];
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
  function tc(ms, opts) {
    ms = Math.max(0, Math.round(Number(ms) || 0));
    var h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
    var base = pad(h) + ":" + pad(m) + ":" + pad(s);
    if (opts && opts.frames && opts.fps) return base + ":" + pad(Math.min(Math.round(opts.fps) - 1, Math.floor(((ms % 1000) / 1000) * opts.fps)));
    return base + "." + Math.floor((ms % 1000) / 100);
  }

  return { parse: parse, only: only, find: find, tokens: tokens, tc: tc, FPS: FPS, MAX_CUES: MAX_CUES, MAX_CUE: MAX_CUE, MAX_TOTAL: MAX_TOTAL, MAX_MS: MAX_MS };
});
