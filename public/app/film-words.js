/* Studio real words and three directions in the TOJ app (migration 041; the
 * API is routes/studio-words.js). Registers screens for app.js:
 *
 *   #film-words/<id>           the film's real words: its transcripts, the
 *                              lines kept (by hand or by Claude), structures,
 *                              cutdowns and captions, and three directions
 *   #film-transcript-new/<id>  add a transcript: read on this phone, and only
 *                              the chosen speaker's lines go to the server
 *   #film-transcript/<tid>     a transcript's cues, to keep a line by hand
 *
 * Every line kept is the speaker's exact words with their timecodes: the
 * server checks it against the transcript, and the database checks again.
 * Adults first: a minor's words wait for a later review. Claude reads a
 * transcript only while Kyron has "Claude reads transcripts" on.
 */
(function () {
  "use strict";
  var T = function () { return window.TOJ; };
  var F = function () { return window.TOJFilms; };
  var P = function () { return window.TOJTranscript; };
  var h = function (s) { return T().h(s); };
  var MSG = {
    label_has_name: "The label shows in the room and the history: no names in it. \"Interview 1\" works.",
    fps: "Pick the frame rate the timeline was cut at.",
    cues: "The transcript's lines couldn't be read. Export it again as .srt.",
    too_many_cues: "That's more than 5,000 lines: split the transcript.",
    too_long: "That transcript is too long for one go: split it.",
    person_id: "Pick whose words these are.",
    not_your_film: "Only the film's director, editor or the producer can do that.",
    remove_the_whole_structure: "A beat goes with its whole structure: remove the structure.",
    no_transcripts: "Add a cleared adult speaker's transcript first.",
    already_running: "One is already being written for this film: it's below. Ask again once it's back.",
    producer_only: "Only the producer (or the film's director, for directions) can do that.",
    changed_meanwhile: "The board changed while you were looking. Open it again.",
  };
  // Why a person's words can't be used now (utils/studio-words.js whyNot).
  var HOLD = {
    adults_first: "a minor's words wait for a later review",
    not_a_speaker: "the card doesn't say they speak in the film",
    consent_pulled: "their consent was pulled",
    not_cleared: "the card isn't cleared yet",
    voice_not_covered: "the release doesn't cover their voice",
    not_on_this_film: "they're not on this film's cards",
  };
  function hold(code) { return HOLD[code] || String(code || "").replace(/_/g, " "); }
  function why(e) {
    var d = (e && e.data) || {};
    if (d.error === "words_not_usable") return "Those words can't be used now: " + (d.why ? hold(d.why) : "the card isn't cleared") + ".";
    if (d.error === "tool_off" && d.tool === "claude_transcripts") return "Claude reads transcripts only once Kyron turns it on (Studio → Films → Tool approvals).";
    if (d.error === "invalid" && d.issues && d.issues.length) {
      // A by-hand pick: the transcript is the one open ("T1#3–4" is Claude's way to say it).
      return d.issues.map(function (x) { x = String(x).replace(/ in T\d+#\d+–\d+/g, " in the lines you picked"); return x.charAt(0).toUpperCase() + x.slice(1); }).join(". ") + ".";
    }
    if (d.error === "invalid" && d.fields && d.fields.every(function (f) { return MSG[f]; })) return d.fields.map(function (f) { return MSG[f]; }).join(" ");
    if (MSG[d.error]) return MSG[d.error];
    return F().why(e);
  }
  function armed(btn, label, fn) {
    btn.addEventListener("click", async function () {
      if (!btn.dataset.armed) { btn.dataset.armed = "1"; var old = btn.textContent; btn.textContent = label; setTimeout(function () { delete btn.dataset.armed; btn.textContent = old; }, 4000); return; }
      btn.disabled = true;
      try { await fn(); } catch (e) { btn.disabled = false; T().toast(why(e)); }
    });
  }
  async function copyText(text, what) {
    try { await navigator.clipboard.writeText(text); T().toast(what + " copied."); }
    catch (e) { T().toast("This browser didn't allow copying: select the words instead."); }
  }
  function words(n) { return (String(n || "").match(/[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*/gu) || []).length; }
  function mins(ms) { var s = Math.round((ms || 0) / 1000); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
  function by(x) { var me = T().state.me && T().state.me.email; return x.made_by === "claude" ? "Claude" : x.made_by === me ? "You" : String(x.made_by || "").replace(/@.*/, ""); }
  var QUOTE = 'style="margin:0;padding:2px 0 2px 12px;border-left:3px solid var(--gold);font:500 16px/1.45 var(--text);color:var(--ink)"';
  var TC = 'class="mono" style="font-size:12.5px;color:var(--muted)"';
  function quote(q) { return "<blockquote " + QUOTE + ">“" + h(q) + "”</blockquote>"; }

  // ── The film's real words ────────────────────────────────────────────
  async function room(id) {
    if (!F().guard()) return;
    var t = T(), back = t.backBtn("#film/" + id, "Film");
    F().loading(back);
    var d;
    try { await F().getMeta(); d = await t.api("/api/studio-words/films/" + encodeURIComponent(id)); } catch (e) { if (e.stale) throw e; return F().failed(back, e); }
    var f = d.film, w = d.words || {}, can = d.can || {};
    var copies = {};
    var tools = function (key, wid) {
      return '<div class="btn-row" style="margin-top:2px"><button type="button" class="btn soft small" data-copy="' + h(key) + '">Copy</button>' + (can.run ? '<button type="button" class="btn ghost small" data-del="' + h(wid) + '">Remove</button>' : "") + "</div>";
    };
    var meta = function (x) {
      return '<div class="sub">' + "<span " + TC + ">" + h(x.at) + "</span>" + h(" · " + [x.speaker ? x.speaker.code + " " + x.speaker.role : "", x.label || "", by(x)].filter(Boolean).join(" · ")) + "</div>";
    };

    var trRows = (d.transcripts || []).map(function (tr) {
      return '<div class="li" style="align-items:flex-start;min-height:0;padding:12px 14px"><div class="grow"><div class="name" style="font-size:15px">' + h(tr.label) + '</div><div class="sub">' + h([tr.code ? tr.code + " " + tr.role : "", tr.cue_count + " lines", (tr.words || 0).toLocaleString() + " words", mins(tr.duration_ms)].filter(Boolean).join(" · ")) + "</div>" +
        (tr.on_hold ? '<div class="sub" style="color:var(--warn)">On hold: ' + h(hold(tr.on_hold)) + "</div>" : "") + "</div>" +
        (tr.on_hold ? F().badge("On hold", "warn") : '<a class="btn soft small" href="#film-transcript/' + h(tr.id) + '">Pick lines</a>') + "</div>";
    }).join("");

    var lines = (w.lines || []).map(function (x) {
      copies["l" + x.id] = x.at + "  “" + x.quote + "”";
      return '<article class="card tight">' + quote(x.quote) + meta(x) + (x.note ? '<p class="body" style="font-size:14px;margin:0">' + h(x.note) + "</p>" : "") + tools("l" + x.id, x.id) + "</article>";
    }).join("");
    var group = function (g, kind) {
      copies[kind + g.id] = g.title + "\n" + g.beats.map(function (b, i) { return (i + 1) + ". " + b.at + "  “" + b.quote + "”"; }).join("\n");
      return '<article class="card tight"><div class="row"><div class="grow"><div class="name" style="font-size:15.5px">' + h(g.title || (kind === "c" ? "Cutdown" : "Structure")) + '</div><div class="sub">' + h(g.beats.length + " beats · " + by(g)) + "</div></div></div>" +
        (g.note ? '<p class="body" style="font-size:14px;margin:0">' + h(g.note) + "</p>" : "") +
        '<ol style="margin:0;padding-left:20px;display:flex;flex-direction:column;gap:8px">' + g.beats.map(function (b) { return '<li style="padding-left:2px"><div ' + TC + ">" + h(b.at) + (b.speaker ? " · " + h(b.speaker.code) : "") + '</div><div class="body" style="font-size:14.5px;color:var(--ink)">“' + h(b.quote) + "”</div></li>"; }).join("") + "</ol>" +
        tools(kind + g.id, g.id) + "</article>";
    };
    var structures = (w.structures || []).map(function (g) { return group(g, "s"); }).join("");
    var cutdowns = (w.cutdowns || []).map(function (g) { return group(g, "c"); }).join("");
    var captions = (w.captions || []).map(function (x) {
      copies["k" + x.id] = x.text;
      return '<article class="card tight"><p class="body" style="font-size:15px;color:var(--ink);margin:0;white-space:pre-wrap">' + h(x.text) + '</p><div class="sub">' + h(words(x.text) + " words · opens on " + x.at + " · " + by(x)) + "</div>" + tools("k" + x.id, x.id) + "</article>";
    }).join("");

    var runs = d.runs || [];
    var going = function (kind) { return runs.find(function (r) { return r.kind === kind && r.status === "running"; }); };
    var lastOf = function (kind) { return runs.find(function (r) { return r.kind === kind; }); };
    var wordsRun = going("words"), dirRun = going("directions");
    var lastWords = lastOf("words"), lastDir = lastOf("directions");
    var stopped = function (r) { return r && r.status === "failed" ? '<p class="body err" style="font-size:14px;margin:0">The last one stopped: ' + h(r.error || "no reason given") + "</p>" : ""; };
    var spinner = function (text, r) { return '<div class="card tight"><div class="row"><div class="spin" aria-hidden="true"></div><div class="grow"><div class="name" style="font-size:15px">' + h(text) + '</div><div class="sub">Started ' + h(t.ago(r.created_at)) + ". You can leave: it lets you know when it's done.</div></div></div></div>"; };
    var usable = (d.transcripts || []).filter(function (x) { return !x.on_hold; }).length;

    var claude = !d.claude_on
      ? '<div class="card tight"><p class="body" style="font-size:14px;margin:0">Claude doesn\'t read transcripts until Kyron turns it on (Studio → Films → Tool approvals). Until then, pick lines by hand.</p></div>'
      : wordsRun ? spinner("Claude is reading the transcripts", wordsRun)
      : '<div class="card tight"><p class="body" style="font-size:14px;margin:0">Claude reads every transcript whose words can be used and hands back the strongest lines, two or three structures, cutdowns that land in the first two seconds, and captions under 60 words that open on the speaker\'s own line. Every quote is checked word for word against the transcript, with its timecodes.</p>' +
        (lastWords && lastWords.status === "waiting" ? '<p class="sub" style="margin:0;color:var(--warn)">The last set didn\'t pass Claude\'s own check: read it closely.</p>' : "") + stopped(lastWords) +
        (can.run ? '<div class="btn-row"><button type="button" class="btn" id="askClaude"' + (usable ? "" : " disabled") + ">" + (lastWords ? "Ask Claude again" : "Ask Claude") + '</button></div><p class="sub" style="margin:0">' + (usable ? "Replaces what Claude picked last time. Lines you kept stay." : "Add a cleared adult speaker's transcript first.") + "</p>" : "") + "</div>";

    // Three directions: the newest set.
    var set = (d.directions || [])[0] || null;
    var dirHtml;
    if (dirRun) dirHtml = spinner("Three directions are being written", dirRun);
    else if (!set) {
      dirHtml = '<div class="card tight"><p class="body" style="font-size:14px;margin:0">Three different ways to make this film, from the board, the kit\'s cards and the taste library, each with its beats, look, sound and three must-have shots. The producer picks one.</p>' + stopped(lastDir) +
        (can.run ? '<div class="btn-row"><button type="button" class="btn soft" id="askDirections">Ask for three directions</button></div>' : "") + "</div>";
    } else {
      dirHtml = '<p class="body" style="font-size:14px;margin:0">I\'d pick ' + set.recommended + (set.why_recommended ? ": " + h(set.why_recommended) : ".") + "</p>" +
        '<div role="radiogroup" aria-label="The three directions" style="display:flex;flex-direction:column;gap:8px">' + set.directions.map(function (x, i) {
          var n = i + 1;
          return '<button type="button" class="radio" role="radio" data-dir="' + n + '"><span class="r"></span><div class="grow"><div class="name" style="font-size:15px">' + n + ". " + h(x.name) + '</div><div class="sub">' + h(x.logline) + "</div></div>" + (set.picked === n ? F().badge("Picked", "ok") : n === set.recommended ? F().badge("Recommended", "gold") : "") + "</button>";
        }).join("") + "</div>" +
        '<div id="dirPanel"></div>' +
        ((set.questions || []).length ? '<section class="card tight" style="background:#182A3F"><div class="name" style="font-size:15px">Questions for the producer</div><ul class="body" style="margin:0;padding-left:20px;font-size:14px">' + set.questions.map(function (q) { return "<li>" + h(q) + "</li>"; }).join("") + "</ul></section>" : "") +
        stopped(lastDir) + (can.run ? '<div class="btn-row"><button type="button" class="btn ghost small" id="askDirections">Ask for a new set</button></div>' : "");
    }

    var sec = function (title, count, body, sub) {
      return '<section class="sec"><div class="row"><h2 class="sec-h grow" style="margin:0">' + h(title) + "</h2>" + (count ? F().badge(String(count)) : "") + "</div>" + (sub ? '<p class="sub" style="margin:0">' + h(sub) + "</p>" : "") + body + "</section>";
    };
    var nothingKept = !lines && !structures && !cutdowns && !captions;
    t.show("studio",
      '<div class="screen">' + back +
      '<div><p class="kicker">Real words · ' + h(F().fmtLabel(f.kit_slug, f.format) + " · " + f.athlete_id) + '</p><h1 class="title sm">' + h(f.title) + "</h1>" +
      '<p class="lede" style="font-size:15px">The speaker\'s own words, exactly as said, with their timecodes. Adults first: a minor\'s words wait for a later review.</p></div>' +
      (f.closed ? '<div class="card tight"><p class="body err" style="margin:0">This film is closed. Nothing more is kept for it.</p></div>' : "") +
      '<section class="sec"><div class="row"><h2 class="sec-h grow" style="margin:0">Transcripts</h2>' + (f.closed ? "" : '<a class="btn soft small" href="#film-transcript-new/' + h(f.id) + '">Add one</a>') + "</div>" +
      (trRows ? '<div class="list">' + trRows + "</div>" : '<p class="empty">No transcripts yet. Export one from Resolve (.srt) and add it: it\'s read on this phone, and only the speaker\'s lines go to the server.</p>') + "</section>" +
      sec("Claude", 0, claude) +
      (nothingKept ? sec("Lines kept", 0, '<p class="empty">Nothing kept yet. Open a transcript and tap the lines that land, or ask Claude.</p>') : "") +
      (lines ? sec("Lines kept", (w.lines || []).length, lines) : "") +
      (structures ? sec("Structures", (w.structures || []).length, structures, "Each one built only from the speaker's lines, in order.") : "") +
      (cutdowns ? sec("Cutdowns", (w.cutdowns || []).length, cutdowns, "The first line lands in the first two seconds.") : "") +
      (captions ? sec("Captions", (w.captions || []).length, captions, "Under 60 words, opening on the speaker's own line.") : "") +
      sec("Three directions", 0, dirHtml) +
      "</div>");

    Array.prototype.forEach.call(document.querySelectorAll("[data-copy]"), function (b) {
      b.addEventListener("click", function () { copyText(copies[b.dataset.copy] || "", "The words"); });
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-del]"), function (b) {
      armed(b, "Tap again to remove", async function () {
        await t.post("/api/studio-words/words/" + encodeURIComponent(b.dataset.del), {}, "DELETE");
        t.toast("Removed.");
        room(id);
      });
    });
    var ask = document.getElementById("askClaude");
    if (ask) ask.addEventListener("click", async function () {
      ask.disabled = true; ask.textContent = "Starting…";
      try { await t.post("/api/studio-words/films/" + encodeURIComponent(id) + "/ask-claude", {}); room(id); }
      catch (e) { ask.disabled = false; ask.textContent = "Ask Claude"; t.toast(why(e)); }
    });
    var askD = document.getElementById("askDirections");
    if (askD) askD.addEventListener("click", async function () {
      askD.disabled = true;
      try { await t.post("/api/studio-words/films/" + encodeURIComponent(id) + "/directions", {}); room(id); }
      catch (e) { askD.disabled = false; t.toast(why(e)); }
    });

    if (set) {
      var shown = set.picked || set.recommended || 1;
      var paint = function () {
        Array.prototype.forEach.call(document.querySelectorAll("[data-dir]"), function (b) { b.setAttribute("aria-checked", String(Number(b.dataset.dir) === shown)); });
        if (t.radios) t.radios();
        var x = set.directions[shown - 1];
        var picked = set.picked === shown;
        document.getElementById("dirPanel").innerHTML = '<article class="card" style="gap:12px">' +
          '<div class="name" style="font-size:17px">' + shown + ". " + h(x.name) + "</div>" +
          '<ol class="body" style="margin:0;padding-left:20px;font-size:14.5px;display:flex;flex-direction:column;gap:4px">' + x.beats.map(function (b) { return "<li>" + h(b) + "</li>"; }).join("") + "</ol>" +
          '<p class="body" style="margin:0;font-size:14px"><b style="color:var(--ink)">Look:</b> ' + h(x.look) + "</p>" +
          (x.sound ? '<p class="body" style="margin:0;font-size:14px"><b style="color:var(--ink)">Sound:</b> ' + h(x.sound) + "</p>" : "") +
          '<div><div class="name" style="font-size:14.5px">Must-have shots</div><ul class="body" style="margin:4px 0 0;padding-left:20px;font-size:14px">' + x.must_have.map(function (m) { return "<li>" + h(m) + "</li>"; }).join("") + "</ul></div>" +
          '<p class="body" style="margin:0;font-size:14px"><b style="color:var(--ink)">Why:</b> ' + h(x.why) + "</p>" +
          (x.risks ? '<p class="body" style="margin:0;font-size:14px"><b style="color:var(--ink)">Risks:</b> ' + h(x.risks) + "</p>" : "") +
          ((x.taste || []).length ? '<div class="sub">From the taste library: ' + x.taste.map(function (r) { return '<a href="' + h(r.url) + '" target="_blank" rel="noopener noreferrer">' + h(r.ref + " " + r.title) + "</a>" + (r.use ? " (" + h(r.use) + ")" : ""); }).join("; ") + "</div>" : "") +
          (can.producer ? '<div class="btn-row"><button type="button" class="btn ' + (picked ? "ghost" : "") + ' small" id="pickDir">' + (picked ? "Unpick it" : "Pick this one") + "</button></div>" : "") +
          '<div class="btn-row">' + (can.run && !f.closed ? '<button type="button" class="btn soft small" id="useMust" style="flex:2">Use its must-haves</button>' : "") +
          '<button type="button" class="btn ghost small" id="copyDir">Copy</button></div>' +
          '<p id="dirMsg" class="sub" role="status" style="margin:0"></p></article>';
        var pick = document.getElementById("pickDir");
        if (pick) pick.addEventListener("click", async function () {
          pick.disabled = true;
          try { await t.post("/api/studio-words/directions/" + encodeURIComponent(set.id) + "/pick", { n: picked ? null : shown }); room(id); }
          catch (e) { pick.disabled = false; t.toast(why(e)); }
        });
        var use = document.getElementById("useMust");
        if (use) armed(use, "Tap again: replaces the board's", async function () {
          await t.post("/api/studio-films/films/" + encodeURIComponent(id), { seen: f.updated_at, plan: Object.assign({}, f.plan || {}, { must_have: x.must_have.slice(0, 3) }) }, "PATCH");
          t.toast("The must-haves are on the board.");
          room(id);
        });
        document.getElementById("copyDir").addEventListener("click", function () {
          copyText([x.name, x.logline, "", x.beats.map(function (b, i) { return (i + 1) + ". " + b; }).join("\n"), "", "Look: " + x.look, x.sound ? "Sound: " + x.sound : "", "Must-have shots: " + x.must_have.join("; "), "Why: " + x.why, x.risks ? "Risks: " + x.risks : ""].filter(function (s) { return s !== ""; }).join("\n"), "The direction");
        });
      };
      Array.prototype.forEach.call(document.querySelectorAll("[data-dir]"), function (b) { b.addEventListener("click", function () { shown = Number(b.dataset.dir); paint(); }); });
      paint();
    }

    // While a run is going, check on it; the screen redraws when it's done.
    var pending = [wordsRun, dirRun].filter(Boolean);
    if (pending.length) {
      var hash = location.hash;
      var check = async function () {
        if (location.hash !== hash) return;
        try {
          var rs = await Promise.all(pending.map(function (r) { return t.api("/api/studio-words/runs/" + encodeURIComponent(r.id)); }));
          if (rs.some(function (x) { return x.run && x.run.status !== "running"; })) return room(id);
        } catch (e) { if (e.stale) return; }
        t.later(check, 5000);
      };
      t.later(check, 5000);
    }
  }

  // ── Add a transcript ─────────────────────────────────────────────────
  var PARSE_MSG = {
    empty: "The file is empty.",
    no_timecodes: "No timecodes in it. Export the transcript from Resolve as subtitles (.srt), or as text with a timecode on each line.",
    no_words: "There are timecodes but no words.",
    cue_too_long: "One line is over 2,000 characters: is this a transcript?",
    too_many_cues: "That's more than 5,000 lines: split the transcript.",
    too_long: "That transcript is too long for one go: split it.",
    past_ten_hours: "Its timecodes run past ten hours. Export it again with the timeline starting at 00:00:00:00 or 01:00:00:00.",
  };
  async function addTranscript(id) {
    if (!F().guard()) return;
    var t = T(), back = t.backBtn("#film-words/" + id, "Real words");
    F().loading(back);
    var d;
    try { d = await t.api("/api/studio-words/films/" + encodeURIComponent(id)); } catch (e) { if (e.stale) throw e; return F().failed(back, e); }
    if (d.film.closed) return F().failed(back, { data: { error: "film_closed" } });
    var people = d.people || [];
    // Nothing is chosen for you: the speaker's lines and whose words they
    // are are both picked by hand.
    var s = { text: null, name: "", fps: null, parsed: null, who: undefined, person: null, label: "Interview " + ((d.transcripts || []).length + 1), only: false };

    // A pause alone is a gap only in a file with no labels (its questions may
    // have been cut out); in a labelled one, the other voices' lines are.
    function chosen() { return s.parsed && s.parsed.ok && s.who !== undefined ? P().only(s.parsed.cues, s.who, { pauses: P().pausesFor(s.parsed) }) : []; }
    function paint() {
      var p = s.parsed;
      var body = "";
      if (p && !p.ok && p.error === "needs_fps") {
        body += '<div class="field"><label class="label" for="fps">Frame rate <small>(the timecodes count frames)</small></label><select class="input" id="fps"><option value="">Pick the timeline\'s frame rate</option>' + P().FPS.map(function (x) { return '<option value="' + x + '"' + (s.fps === x ? " selected" : "") + ">" + x + "</option>"; }).join("") + "</select></div>";
      } else if (p && !p.ok) {
        body += '<p class="body err">' + h(PARSE_MSG[p.error] || "That file couldn't be read as a transcript.") + "</p>";
      } else if (p && p.ok) {
        var labelled = p.labelled;
        body += '<p class="sub" style="margin:0">' + h(p.cues.length + " lines read" + (p.frames ? " at " + p.fps + " fps" : "") + ".") + "</p>";
        if (labelled) {
          body += '<div class="field"><span class="label" id="whoLabel">Whose lines in the file are the speaker\'s?</span><div role="radiogroup" aria-labelledby="whoLabel" style="display:flex;flex-direction:column;gap:8px">' + p.speakers.map(function (x, i) {
            var first = p.cues.find(function (c) { return c.who === x.who; });
            return '<button type="button" class="radio" role="radio" aria-checked="' + (s.who === x.who) + '" data-who="' + i + '"><span class="r"></span><div class="grow"><div class="name" style="font-size:15px">' + h(x.who || "(no label: a voice the file doesn't name)") + '</div><div class="sub">' + h(x.cues + " lines · “" + (first ? first.t.slice(0, 70) : "") + (first && first.t.length > 70 ? "…" : "") + "”") + "</div></div></button>";
          }).join("") + '</div><p class="sub" style="margin:4px 0 0">Only those lines go. The other voices\' lines stay on this phone, and a subtitle with two voices in it is split between them.' + (p.mixed ? " " + h(p.mixed + " line" + (p.mixed === 1 ? "" : "s") + " with another voice in them and no label (dashed, after \">>\" or a bracket, and the lines with them) stay on this phone: they're nobody's here.") : "") + "</p></div>";
        } else {
          s.who = null;
          if (!p.voices) body += '<div class="card tight" style="border-color:#5A4A2A"><p class="body" style="font-size:14px;margin:0">This file marks where the voice changes but names no one, so none of its lines can go as the speaker\'s words. Export it again with speaker labels.</p></div>';
          else body += '<div class="card tight" style="border-color:#5A4A2A"><p class="body" style="font-size:14px;margin:0">This file has no speaker labels, so every line in it goes as the speaker\'s words. If the questions are in it, export it again with speaker names, or take them out first.' + (p.mixed ? " " + h(p.mixed + " line" + (p.mixed === 1 ? "" : "s") + " with another voice in them (dashed, after \">>\" or a bracket, and the lines with them) stay on this phone.") : "") + "</p>" +
            '<label class="row" style="gap:10px;cursor:pointer;min-height:40px"><input type="checkbox" class="switch" id="onlyThem"' + (s.only ? " checked" : "") + '><span class="body" style="font-size:14px;color:var(--ink)">Only the speaker\'s words are in this file</span></label></div>';
        }
        body += '<div class="field"><span class="label" id="personLabel">Whose words are they?</span>' + (people.length ? '<div role="radiogroup" aria-labelledby="personLabel" style="display:flex;flex-direction:column;gap:8px">' + people.map(function (x) {
          return '<button type="button" class="radio" role="radio" aria-checked="' + (s.person === x.id) + '" data-person="' + h(x.id) + '"' + (x.why_not ? ' aria-disabled="true" style="opacity:.6;cursor:not-allowed"' : "") + '><span class="r"></span><div class="grow"><div class="name" style="font-size:15px">' + h(x.code + " · " + x.role) + "</div>" + (x.why_not ? '<div class="sub">' + h("Not now: " + hold(x.why_not)) + "</div>" : "") + "</div></button>";
        }).join("") + "</div>" : '<p class="empty">No cards on this film yet.</p>') + "</div>";
        body += '<div class="field"><label class="label" for="trLabel">Label <small>(no names: "Interview 1", "Walk and talk")</small></label><input class="input" id="trLabel" maxlength="60" value="' + h(s.label) + '"></div>';
        var c = chosen();
        var whose = people.find(function (x) { return x.id === s.person; });
        if (c.length) body += '<section class="sec"><h2 class="sec-h">What goes to the server' + (whose ? h(", as " + whose.code + " · " + whose.role + "'s words") : "") + '</h2><div class="card tight" style="gap:8px">' + c.slice(0, 3).map(function (x) { return '<div><div ' + TC + ">" + h(P().tc(x.s, { frames: p.frames, fps: p.fps, drop: p.drop })) + '</div><div class="body" style="font-size:14px;color:var(--ink)">' + h(x.t) + "</div></div>"; }).join("") + (c.length > 3 ? '<p class="sub" style="margin:0">' + h("…and " + (c.length - 3) + " more of their lines.") + "</p>" : "") + "</div></section>";
      }
      var c2 = chosen();
      var ready = p && p.ok && c2.length && s.person && (p.labelled ? s.who !== undefined && s.who !== null : s.only);
      t.show(null,
        '<div class="screen">' + back +
        '<div><p class="kicker">Add a transcript</p><h1 class="title sm">' + h(d.film.title) + '</h1><p class="lede" style="font-size:15px">Export the interview\'s transcript from Resolve: subtitles (.srt), or text with a timecode on each line. It\'s read on this phone, and only the speaker\'s lines go to the server.</p></div>' +
        '<label class="btn soft" style="cursor:pointer"><input type="file" id="trFile" accept=".srt,.vtt,.txt,text/plain,text/vtt" class="sr">' + (s.name ? "Choose another file" : "Choose the transcript") + "</label>" +
        (s.name ? '<p class="sub" style="margin:0">' + h(s.name) + "</p>" : "") +
        body + '<p id="trMsg" class="body" role="status"></p></div>' +
        '<div class="dock"><div class="dock-inner"><button type="button" class="btn block" id="trSend"' + (ready ? "" : " disabled") + ">" + (c2.length ? "Send " + c2.length + " lines" : "Send the speaker's lines") + "</button></div></div>");
      wire();
      if (T().radios) T().radios();
      // A choice made with the arrow keys repaints the screen: the focus goes
      // back to the choice, so the next arrow key works too.
      if (s.focus) {
        var back2 = document.querySelector("[data-" + s.focus + '][aria-checked="true"]');
        if (back2) back2.focus();
        s.focus = null;
      }
    }
    function read() {
      var r = P().parse(s.text, { fps: s.fps });
      s.parsed = r;
      if (r.ok) {
        // One voice in the whole file, and it's named: that's the speaker.
        // Otherwise ask.
        s.who = r.labelled ? (r.speakers.length === 1 ? r.speakers[0].who : undefined) : null;
      }
      paint();
    }
    function wire() {
      document.getElementById("trFile").addEventListener("change", async function () {
        var file = this.files && this.files[0];
        if (!file) return;
        if (file.size > 3 * 1024 * 1024) { s.parsed = { ok: false, error: "too_long" }; s.name = file.name; return paint(); }
        try { s.text = await file.text(); } catch (e) { s.parsed = { ok: false, error: "empty" }; return paint(); }
        s.name = file.name; s.fps = null; s.only = false;
        read();
      });
      var fps = document.getElementById("fps");
      if (fps) fps.addEventListener("change", function () { s.fps = Number(fps.value) || null; if (s.fps) read(); });
      Array.prototype.forEach.call(document.querySelectorAll("[data-who]"), function (b) {
        b.addEventListener("click", function () { s.who = s.parsed.speakers[Number(b.dataset.who)].who; s.focus = document.activeElement === b ? "who" : null; paint(); });
      });
      Array.prototype.forEach.call(document.querySelectorAll("[data-person]"), function (b) {
        b.addEventListener("click", function () {
          var x = people.find(function (q) { return q.id === b.dataset.person; });
          if (x && x.why_not) return T().toast("Not now: " + hold(x.why_not) + ".");
          s.person = b.dataset.person; s.focus = document.activeElement === b ? "person" : null; paint();
        });
      });
      var only = document.getElementById("onlyThem");
      if (only) only.addEventListener("change", function () { s.only = only.checked; paint(); });
      var label = document.getElementById("trLabel");
      if (label) label.addEventListener("input", function () { s.label = label.value; });
      document.getElementById("trSend").addEventListener("click", async function () {
        var btn = this;
        var p = s.parsed;
        // gap: this line came after someone else's (left out) or a long pause.
        var cues = chosen().map(function (c) { return c.gap ? { s: c.s, e: c.e, t: c.t, gap: true } : { s: c.s, e: c.e, t: c.t }; });
        btn.disabled = true; btn.textContent = "Sending…";
        try {
          await T().post("/api/studio-words/films/" + encodeURIComponent(id) + "/transcripts", { person_id: s.person, label: (s.label || "").trim(), frames: !!p.frames, fps: p.frames ? p.fps : null, drop: !!p.drop, labelled: !!p.labelled, voices: p.voices, cues: cues });
          T().toast("Transcript added: " + cues.length + " lines.");
          T().go("#film-words/" + id);
        } catch (e) {
          btn.disabled = false; btn.textContent = "Send " + cues.length + " lines";
          F().say("trMsg", why(e), true);
        }
      });
    }
    paint();
  }

  // ── Keep a line by hand ──────────────────────────────────────────────
  async function transcript(tid) {
    if (!F().guard()) return;
    var t = T();
    F().loading(t.backBtn("#films", "Films"));
    var tr, d;
    try {
      tr = (await t.api("/api/studio-words/transcripts/" + encodeURIComponent(tid))).transcript;
      d = await t.api("/api/studio-words/films/" + encodeURIComponent(tr.film_id));
    } catch (e) { if (e.stale) throw e; return F().failed(t.backBtn("#films", "Films"), e); }
    var back = t.backBtn("#film-words/" + tr.film_id, "Real words");
    var opts = { frames: tr.frames, fps: tr.fps, drop: tr.df_timecode };
    var used = {};
    var all = [].concat((d.words || {}).lines || [], (d.words || {}).captions || []);
    ((d.words || {}).structures || []).concat((d.words || {}).cutdowns || []).forEach(function (g) { all = all.concat(g.beats); });
    all.forEach(function (x) { if (x.transcript_id === tr.id) for (var n = x.from_cue; n <= x.to_cue; n++) used[n] = true; });
    var s = { from: null, to: null, find: "", kind: "line", text: "", note: "", after: "", limit: 300 };
    var closed = d.film.closed || !!tr.on_hold || !(d.can && d.can.run);

    function joined() {
      if (s.from == null) return "";
      return tr.cues.slice(s.from - 1, s.to).map(function (c) { return c.t; }).join(" ");
    }
    function list() {
      var q = s.find.trim().toLowerCase();
      var hits = q ? tr.cues.filter(function (c) { return c.t.toLowerCase().indexOf(q) >= 0; }) : tr.cues;
      var shown = hits.slice(0, s.limit);
      return '<div class="list" id="cues">' + shown.map(function (c, k) {
        var on = s.from != null && c.n >= s.from && c.n <= s.to;
        // A gap: someone else's words, or a long pause, came before this
        // line. A kept line doesn't reach across it.
        var gapMark = c.gap && (k > 0 || q) ? '<div class="sub" role="separator" style="font-size:12px;padding:4px 14px;color:var(--muted)">' + h("· a question or a long pause here: a line doesn't reach across it ·") + "</div>" : "";
        return gapMark + '<button type="button" class="li" data-cue="' + c.n + '" aria-pressed="' + on + '" style="align-items:flex-start;min-height:0;padding:10px 14px;' + (on ? "background:#1A2C45;box-shadow:inset 3px 0 0 var(--gold)" : "") + '"><div style="flex:none;width:96px"><div ' + TC + ">" + h(P().tc(c.s, opts)) + '</div><div class="sub" style="font-size:12px">' + c.n + (used[c.n] ? " · kept" : "") + '</div></div><div class="grow body" style="font-size:14.5px;color:var(--ink)">' + h(c.t) + "</div></button>";
      }).join("") + "</div>" + (hits.length > shown.length ? '<button type="button" class="btn ghost small" id="more">Show more (' + (hits.length - shown.length) + " left)</button>" : "") + (q && !hits.length ? '<p class="empty">No line has those words.</p>' : "");
    }
    function dock() {
      if (closed || s.from == null) return "";
      var n = words(s.text) + (s.kind === "caption" ? words(s.after) : 0);
      return '<div class="dock"><div class="dock-inner" style="display:flex;flex-direction:column;gap:8px;align-items:stretch">' +
        '<div class="seg" role="group" aria-label="Keep it as"><button type="button" data-kind="line" aria-pressed="' + (s.kind === "line") + '">A line</button><button type="button" data-kind="caption" aria-pressed="' + (s.kind === "caption") + '">A caption</button></div>' +
        '<label class="sr" for="kText">The speaker\'s exact words</label><textarea class="textarea" id="kText" style="min-height:76px">' + h(s.text) + "</textarea>" +
        (s.kind === "caption" ? '<label class="sr" for="kAfter">After the line</label><textarea class="textarea" id="kAfter" style="min-height:56px" placeholder="After their line (optional, your words, no names)">' + h(s.after) + '</textarea><p class="sub" style="margin:0" id="kCount">' + n + " of under 60 words</p>" : '<input class="input" id="kNote" maxlength="300" placeholder="Why it lands (optional)" value="' + h(s.note) + '">') +
        '<div class="row" style="gap:8px"><button type="button" class="btn ghost" id="kClear" style="flex:none">Clear</button><button type="button" class="btn grow" id="kKeep">' + (s.kind === "caption" ? "Keep the caption" : "Keep the line") + "</button></div>" +
        '<p id="kMsg" class="sub" role="status" style="margin:0"></p></div></div>';
    }
    function paint(keepScroll) {
      var y = window.scrollY;
      t.show(null,
        '<div class="screen">' + back +
        '<div><p class="kicker">' + h(tr.label + (tr.code ? " · " + tr.code + " " + tr.role : "")) + (d.film.closed ? "" : ' <button type="button" class="btn ghost small" id="trRename" style="min-height:0;padding:2px 10px;margin-left:6px">Rename</button>') + "</p>" +
        (s.renaming ? '<div class="row" style="gap:8px;margin:6px 0"><label class="sr" for="trNewLabel">New label</label><input class="input grow" id="trNewLabel" maxlength="60" value="' + h(s.renaming.value) + '" placeholder="No names: Interview 1"><button type="button" class="btn small" id="trRenameGo">Save</button><button type="button" class="btn ghost small" id="trRenameNo">Cancel</button></div><p class="sub" role="status" id="trRenameMsg" style="margin:0"></p>' : "") +
        '<h1 class="title sm">Pick the lines</h1>' +
        (tr.on_hold ? '<p class="body err">On hold: ' + h(hold(tr.on_hold)) + ". Nothing more is kept from it for now.</p>" : closed ? '<p class="lede" style="font-size:15px">Read only: the film is closed, or it isn\'t yours to edit.</p>' : '<p class="lede" style="font-size:15px">Tap a line to start, then tap another to end (12 at most). Trim the words to the line you want: they have to be the speaker\'s own, word for word.</p>') + "</div>" +
        '<label class="sr" for="kFind">Find words</label><input class="input" id="kFind" type="search" placeholder="Find words" value="' + h(s.find) + '">' +
        '<div id="cueBox" style="display:flex;flex-direction:column;gap:10px">' + list() + "</div>" + (s.from != null && !closed ? '<div style="height:260px" aria-hidden="true"></div>' : "") + "</div>" + dock());
      if (keepScroll) window.scrollTo(0, y);
      wire();
    }
    // Nothing picked: a tap starts there. One picked: a tap on another
    // makes the range (the same one clears it). A range: a tap starts again.
    function select(n) {
      if (s.from == null || s.from !== s.to) { s.from = s.to = n; }
      else if (n === s.from) { s.from = s.to = null; }
      else {
        var a = Math.min(s.from, n), b = Math.max(s.from, n);
        if (b - a > 11) { T().toast("A line spans 12 at most."); return; }
        s.from = a; s.to = b;
      }
      s.text = joined();
      paint(true);
    }
    function wire() {
      var find = document.getElementById("kFind");
      find.addEventListener("input", function () {
        s.find = find.value; s.limit = 300;
        document.getElementById("cueBox").innerHTML = list();
        wireList();
      });
      wireList();
      // Rename the transcript (a word of a name in its label holds a card back).
      var rn = document.getElementById("trRename");
      if (rn) rn.addEventListener("click", function () { s.renaming = s.renaming ? null : { value: tr.label }; paint(true); var i = document.getElementById("trNewLabel"); if (i) i.focus(); });
      var rnIn = document.getElementById("trNewLabel");
      if (rnIn) rnIn.addEventListener("input", function () { s.renaming.value = rnIn.value; });
      var rnNo = document.getElementById("trRenameNo");
      if (rnNo) rnNo.addEventListener("click", function () { s.renaming = null; paint(true); });
      var rnGo = document.getElementById("trRenameGo");
      if (rnGo) rnGo.addEventListener("click", async function () {
        rnGo.disabled = true;
        try {
          var r = await T().post("/api/studio-words/transcripts/" + encodeURIComponent(tr.id), { label: (s.renaming.value || "").trim() }, "PATCH");
          tr.label = r.transcript.label;
          s.renaming = null;
          paint(true);
          T().toast("Renamed.");
        } catch (e) {
          rnGo.disabled = false;
          var f = (e.data && e.data.fields) || [];
          F().say("trRenameMsg", f.indexOf("label_has_name") >= 0 ? "No names in a label: \"Interview 1\", \"Walk and talk\"." : f.indexOf("label") >= 0 ? "Give it a label." : why(e), true);
        }
      });
      if (closed || s.from == null) return;
      Array.prototype.forEach.call(document.querySelectorAll("[data-kind]"), function (b) { b.addEventListener("click", function () { s.kind = b.dataset.kind; paint(true); }); });
      var text = document.getElementById("kText"), note = document.getElementById("kNote"), after = document.getElementById("kAfter");
      var count = function () { var c = document.getElementById("kCount"); if (c) c.textContent = (words(s.text) + words(s.after)) + " of under 60 words"; };
      text.addEventListener("input", function () { s.text = text.value; count(); });
      if (note) note.addEventListener("input", function () { s.note = note.value; });
      if (after) after.addEventListener("input", function () { s.after = after.value; count(); });
      document.getElementById("kClear").addEventListener("click", function () { s.from = s.to = null; s.text = ""; paint(true); });
      document.getElementById("kKeep").addEventListener("click", async function () {
        var btn = this;
        btn.disabled = true;
        var body = { transcript_id: tr.id, from_cue: s.from, to_cue: s.to, quote: s.text.trim(), kind: s.kind };
        if (s.kind === "caption") body.after = s.after.trim(); else body.note = s.note.trim();
        // A word that's also a name on a card was asked about: sent again for
        // the same words, it's the writer's "not a name here".
        var sig = JSON.stringify([body.from_cue, body.to_cue, body.quote, body.note || "", body.after || "", body.kind]);
        if (s.asked && s.asked.sig === sig) body.names_ok = s.asked.words;
        try {
          var r = await t.post("/api/studio-words/films/" + encodeURIComponent(tr.film_id) + "/lines", body);
          var kept = r.line;
          if (kept) for (var n = kept.from_cue || s.from; n <= (kept.to_cue || s.to); n++) used[n] = true;
          t.toast(s.kind === "caption" ? "Caption kept." : "Line kept" + (kept && kept.start_ms != null ? ": " + P().tc(kept.start_ms, opts) : "") + ".");
          s.from = s.to = null; s.text = ""; s.note = ""; s.after = "";
          paint(true);
        } catch (e) {
          btn.disabled = false;
          var dd = (e && e.data) || {};
          if (dd.error === "invalid" && (dd.fields || []).indexOf("may_have_name") >= 0) {
            s.asked = { sig: sig, words: (body.names_ok || []).concat(dd.words || []) };
            return F().say("kMsg", "“" + (dd.words || []).join("”, “") + "” is also a name on a card. If it isn't a name here, tap Keep again.", true);
          }
          F().say("kMsg", why(e), true);
        }
      });
    }
    function wireList() {
      Array.prototype.forEach.call(document.querySelectorAll("[data-cue]"), function (b) {
        b.addEventListener("click", function () { if (closed) return; select(Number(b.dataset.cue)); });
      });
      var more = document.getElementById("more");
      if (more) more.addEventListener("click", function () {
        s.limit += 300;
        document.getElementById("cueBox").innerHTML = list();
        wireList();
      });
    }
    paint();
  }

  window.TOJScreens = Object.assign(window.TOJScreens || {}, { "film-words": room, "film-transcript-new": addTranscript, "film-transcript": transcript });
})();
