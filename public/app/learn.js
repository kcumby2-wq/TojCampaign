/* The kit learns from the work, in the TOJ app (migration 042; the API is
 * routes/studio-learn.js). Registers screens for app.js:
 *
 *   #film-wraps/<id>    a film's wrap-ups: what worked, what missed, what the
 *                       kit should change. They go into the month's refresh.
 *   #monthly/<slug>     the month's kit refresh (approvers): the wrap-ups,
 *                       suggested edits and rules in the making, ticked into
 *                       a brief for the Kit Refresher, which still makes only
 *                       a draft for Kyron to approve.
 *
 * Today's parts (TOJLearn.todayParts): the month's refresh when it's due
 * (approvers), and the gear re-check a month after the last one.
 */
(function () {
  "use strict";
  var T = function () { return window.TOJ; };
  var h = function (s) { return T().h(s); };
  var MSG = {
    worked: "Say what worked.",
    banned_words: "A word on the TOJ banned list is in it. Say the concrete thing instead.",
    wrap_has_name: "Wrap-ups keep no names (they go to the whole kit): write the code instead.",
    wrap_has_minor_name: "That's part of a minor's name on a card. Write the code instead.",
    suggestion: "Say what the card should say.",
    suggestion_has_name: "A kit never carries a name: write it without one.",
    note: "Say why, in a few words.",
    note_has_name: "No names: write it without one.",
    card: "That card isn't in the approved kit anymore. Open the kit again.",
    card_is_a_rule: "That card is one of the kit's rules: a refresh can't change it.",
    brief_has_name: "The brief names someone on a card. Write the code instead, then start it.",
    refresh_needs_a_person: "A person starts the month's refresh and the gear re-check.",
    refresh_unavailable: "The refresh couldn't be marked right now, so it didn't start. Try again in a minute.",
    not_yours: "Only whoever wrote it can change it.",
    folded: "It's in a refresh already, so it stays as it is.",
    producer_only: "Only an approver (or Kyron) can do that.",
    decided_already: "Someone decided about it already. Open it again.",
    no_approved_kit: "That kit has no approved version.",
    storage_unavailable: "The server can't reach its database right now.",
    not_found: "Not found. It may have been removed.",
  };
  function why(e) {
    var d = (e && e.data) || {};
    if ((d.error === "refused" || d.error === "refresh_refused") && d.reason) return d.reason.charAt(0).toUpperCase() + d.reason.slice(1) + ".";
    if (d.error === "invalid" && d.fields) return d.fields.map(function (f) { return MSG[f] || "Check the " + f.replace(/_/g, " ") + "."; }).join(" ");
    return MSG[d.error] || (e && e.message) || "That didn't work.";
  }
  function guard(level) { if (!T().atLeast(level || "member") || !T().hasTool("studio")) { T().go("#studio"); return false; } return true; }
  function say(id, text, bad) { var el = document.getElementById(id); if (el) el.innerHTML = '<span class="' + (bad ? "err" : "") + '">' + h(text) + "</span>"; }
  function day(iso) { return iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : ""; }
  function monthName(ym) { var d = new Date(ym + "T12:00:00"); return d.toLocaleDateString(undefined, { month: "long", year: "numeric" }); }
  function fmt(slug, f) { var F = window.TOJFilms; return F && F.fmtLabel ? F.fmtLabel(slug, f) : f; }

  // ── A film's wrap-ups ────────────────────────────────────────────────
  async function wraps(id) {
    if (!guard()) return;
    var t = T(), back = t.backBtn("#film/" + id, "Film");
    t.show(null, '<div class="screen">' + back + '<div class="spin"></div></div>');
    var d;
    try {
      if (window.TOJFilms && window.TOJFilms.getMeta) await window.TOJFilms.getMeta();
      d = await t.api("/api/studio-learn/films/" + encodeURIComponent(id) + "/wraps");
    } catch (e) {
      if (e.stale) throw e;
      return t.show(null, '<div class="screen">' + back + '<h1 class="title sm">Couldn\'t open it</h1><p class="body err">' + h(why(e)) + "</p></div>");
    }
    var f = d.film;
    var editing = null; // a wrap-up's id, or "new"
    var asked = { text: "", words: [] };
    // What's typed in the form, kept across repaints; and what it started
    // as, so a half-written one is never thrown away without asking.
    var draft = null, start = null;
    var leaving = null; // { go: "new" | id } while asking
    var FIELDS = [["wWorked", "worked"], ["wMissed", "missed"], ["wChange", "change"], ["wCard", "card_title"]];
    function fill(w) { w = w || {}; return { worked: w.worked || "", missed: w.missed || "", change: w.change || "", card_title: w.card_title || "" }; }
    function dirty() { return !!draft && FIELDS.some(function (x) { return draft[x[1]].trim() !== start[x[1]].trim(); }); }
    function open(target) {
      editing = target;
      var cur = target === "new" ? null : d.wraps.find(function (x) { return x.id === target; });
      draft = fill(cur); start = fill(cur);
      asked = { text: "", words: [] };
      leaving = null;
      paint();
      var first = document.getElementById("wWorked");
      if (first) first.focus();
    }
    function close() { editing = null; draft = null; start = null; leaving = null; paint(); }
    function row(w) {
      var lines = [["Worked", w.worked], ["Missed", w.missed], ["Change", w.change]].filter(function (x) { return x[1]; });
      return '<article class="card tight" style="gap:8px">' + lines.map(function (x) { return '<p class="body" style="margin:0;font-size:14.5px"><b style="color:var(--ink)">' + x[0] + ":</b> " + h(x[1]) + "</p>"; }).join("") +
        (w.card_title ? '<div class="sub">About the card: ' + h(w.card_title) + "</div>" : "") +
        '<div class="row" style="gap:8px"><div class="grow sub">' + h(String(w.created_by || "").replace(/@.*/, "") + " · " + day(w.created_at)) + "</div>" +
        (w.folded ? '<span class="badge ok">In a refresh</span>' : w.mine && editing !== w.id ? '<button type="button" class="btn ghost small" data-edit="' + h(w.id) + '">Edit</button>' : "") +
        (!w.folded && (w.mine || d.can.producer) ? '<button type="button" class="btn ghost small" data-del="' + h(w.id) + '">Remove</button>' : "") + "</div></article>";
    }
    function form() {
      var w = draft;
      return '<section class="card" style="gap:12px"><div class="name" style="font-size:16px">' + (editing === "new" ? "Add a wrap-up" : "Edit the wrap-up") + "</div>" +
        (leaving ? '<div class="card tight" role="alert" style="gap:8px"><p class="body" style="margin:0;font-size:14px">This wrap-up isn\'t saved. ' + (leaving.go === "close" ? "Close it anyway? What you wrote is lost." : "Open the other one anyway? What you wrote here is lost.") + '</p><div class="btn-row"><button type="button" class="btn small" id="wKeep">Keep writing</button><button type="button" class="btn ghost small" id="wDiscard">' + (leaving.go === "close" ? "Close it" : "Discard and open") + "</button></div></div>" : "") +
        '<div class="field"><label class="label" for="wWorked">What worked</label><textarea class="textarea" id="wWorked" maxlength="600" style="min-height:76px">' + h(w.worked) + "</textarea></div>" +
        '<div class="field"><label class="label" for="wMissed">What missed <small>(optional)</small></label><textarea class="textarea" id="wMissed" maxlength="600" style="min-height:64px">' + h(w.missed) + "</textarea></div>" +
        '<div class="field"><label class="label" for="wChange">What the kit should change <small>(optional)</small></label><textarea class="textarea" id="wChange" maxlength="600" style="min-height:64px">' + h(w.change) + "</textarea></div>" +
        '<div class="field"><label class="label" for="wCard">Which kit card <small>(optional)</small></label><input class="input" id="wCard" list="wCards" maxlength="200" value="' + h(w.card_title) + '"><datalist id="wCards">' + (d.cards || []).map(function (c) { return '<option value="' + h(c) + '"></option>'; }).join("") + "</datalist></div>" +
        '<p class="sub" style="margin:0">No names: write the code. It goes into the month\'s kit refresh.</p>' +
        '<div class="btn-row"><button type="button" class="btn" id="wSave">Save the wrap-up</button><button type="button" class="btn ghost" id="wCancel">Cancel</button></div><p id="wMsg" class="body" role="status" style="margin:0"></p></section>';
    }
    function paint() {
      var list = d.wraps || [];
      t.show(null,
        '<div class="screen">' + back +
        '<div><p class="kicker">Wrap-ups · ' + h(fmt(f.kit_slug, f.format) + " · " + f.athlete_id) + '</p><h1 class="title sm">' + h(f.title) + "</h1>" +
        '<p class="lede" style="font-size:15px">What worked on this film, what missed, and what the kit should change. Each one goes into the month\'s kit refresh, once.</p></div>' +
        (list.length ? '<div style="display:flex;flex-direction:column;gap:10px">' + list.map(row).join("") + "</div>" : '<p class="empty">No wrap-ups yet.</p>') +
        (editing ? form() : '<button type="button" class="btn soft" id="wAdd">Add a wrap-up</button>') +
        "</div>");
      wire();
    }
    // Leave the form for another one (or close it): asked first when what's
    // typed isn't saved.
    function leave(go) {
      if (dirty()) { leaving = { go: go }; paint(); var k = document.getElementById("wKeep"); if (k) k.focus(); return; }
      if (go === "close") close(); else open(go);
    }
    function wire() {
      var add = document.getElementById("wAdd");
      if (add) add.addEventListener("click", function () { open("new"); });
      Array.prototype.forEach.call(document.querySelectorAll("[data-edit]"), function (b) { b.addEventListener("click", function () { leave(b.dataset.edit); }); });
      FIELDS.forEach(function (x) {
        var el = document.getElementById(x[0]);
        if (el) el.addEventListener("input", function () { draft[x[1]] = el.value; });
      });
      var keep = document.getElementById("wKeep");
      if (keep) keep.addEventListener("click", function () { leaving = null; paint(); });
      var discard = document.getElementById("wDiscard");
      if (discard) discard.addEventListener("click", function () { var go = leaving.go; leaving = null; if (go === "close") close(); else open(go); });
      Array.prototype.forEach.call(document.querySelectorAll("[data-del]"), function (b) {
        b.addEventListener("click", async function () {
          if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Tap again to remove"; setTimeout(function () { if (b.isConnected) { delete b.dataset.armed; b.textContent = "Remove"; } }, 4000); return; }
          b.disabled = true;
          var gone = b.dataset.del;
          try {
            await t.post("/api/studio-learn/wraps/" + encodeURIComponent(gone), {}, "DELETE");
            d.wraps = d.wraps.filter(function (x) { return x.id !== gone; });
            // The form stays as typed, unless it was this one.
            if (editing === gone) { editing = null; draft = null; start = null; leaving = null; }
            paint();
            t.toast("Removed.");
          } catch (e) { b.disabled = false; t.toast(why(e)); }
        });
      });
      var cancel = document.getElementById("wCancel");
      if (cancel) cancel.addEventListener("click", function () { leave("close"); });
      var save = document.getElementById("wSave");
      if (save) save.addEventListener("click", async function () {
        var body = { worked: draft.worked.trim(), missed: draft.missed.trim(), change: draft.change.trim(), card_title: draft.card_title.trim() };
        var text = [body.worked, body.missed, body.change, body.card_title].join("\n");
        body.names_ok = asked.text === text ? asked.words : [];
        save.disabled = true;
        try {
          var r = editing === "new"
            ? await t.post("/api/studio-learn/films/" + encodeURIComponent(id) + "/wraps", body)
            : await t.post("/api/studio-learn/wraps/" + encodeURIComponent(editing), body, "PATCH");
          if (editing === "new") d.wraps.push(r.wrap); else d.wraps = d.wraps.map(function (x) { return x.id === r.wrap.id ? r.wrap : x; });
          close();
          t.toast("Saved.");
        } catch (e) {
          save.disabled = false;
          var dd = e && e.data;
          if (dd && dd.error === "invalid" && (dd.fields || []).indexOf("wrap_may_have_name") >= 0) {
            asked = { text: text, words: body.names_ok.concat(dd.words || []) };
            return say("wMsg", "“" + (dd.words || []).join("”, “") + "” is also a name on a card. If it isn't a name here, save again.");
          }
          say("wMsg", why(e), true);
        }
      });
    }
    paint();
  }

  // ── The month's refresh ──────────────────────────────────────────────
  // The brief, from what's ticked, under the kit run's limit (with room left
  // for your edits): what doesn't fit is left for next month. The ticks
  // decide what it's given, and what's folded in once it saves a draft.
  function compose(d, ticked) {
    var max = (d.brief_max || 6000) - 200;
    var head = "Monthly refresh of " + d.kit.title + " (v" + d.kit.version + "), " + monthName(d.month) + ": fold in what the team learned" + (d.last_ran ? " since " + day(d.last_ran.started_at) : "") + ".\n\n" +
      "Change only what these ask for, card by card. Keep every rule card as it is, and date anything that changes. Where you don't make a change one of them asks for, say why in the draft's notes.\n";
    var text = head;
    var used = { wraps: [], suggestions: [], labels: [] };
    var lines = {}; // what's ticked and in the brief: its line, by tick key
    var left = 0;
    function section(title, items, line, key, idOf) {
      var picked = items.filter(function (x) { return ticked[key + ":" + idOf(x)]; });
      if (!picked.length) return;
      var block = "\n## " + title + "\n";
      picked.forEach(function (x) {
        var l = "- " + line(x) + "\n";
        if (text.length + block.length + l.length > max) { left++; return; }
        block += l;
        used[key].push(idOf(x));
        lines[key + ":" + idOf(x)] = l.slice(0, -1);
      });
      if (block.indexOf("\n- ") >= 0) text += block;
    }
    var cut = function (s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
    section("Suggested edits", d.suggestions, function (x) { return x.column_name + " › " + x.card_title + ": " + cut(x.suggestion, 400) + (x.why ? " (why: " + cut(x.why, 200) + ")" : ""); }, "suggestions", function (x) { return x.id; });
    section("Wrap-ups from films", d.wraps, function (x) {
      return fmt(d.kit.slug, x.film.format) + " " + x.film.athlete_id + ": worked: " + cut(x.worked, 220) + (x.missed ? "; missed: " + cut(x.missed, 220) : "") + (x.change ? "; change: " + cut(x.change, 220) : "") + (x.card_title ? " (card: " + x.card_title + ")" : "");
    }, "wraps", function (x) { return x.id; });
    section("Rules in the making", d.rules, function (x) {
      return "“" + x.label + "” came up in " + x.notes + " review notes on " + x.films + (x.films === 1 ? " film" : " films") + ". Propose a rule card for it in the right column, or say why not." + (x.samples && x.samples.length ? " For example: “" + cut(x.samples[0], 160) + "”" : "");
    }, "labels", function (x) { return x.label; });
    if (left) text += "\n(" + left + " more didn't fit: they stay for next month.)\n";
    return { text: text.trim(), used: used, left: left, lines: lines };
  }
  // A line taken out of a brief, with its line break.
  function withoutLine(text, line) {
    var i = text.indexOf(line);
    if (i < 0) return null;
    var end = i + line.length;
    if (text.charAt(end) === "\n") end++;
    else if (i > 0 && text.charAt(i - 1) === "\n") i--;
    return text.slice(0, i) + text.slice(end);
  }
  async function monthly(slug) {
    if (!guard("approver")) return;
    var t = T(), back = t.backBtn("#today", "Today");
    t.show(null, '<div class="screen">' + back + '<div class="spin"></div></div>');
    var d;
    try {
      if (window.TOJFilms && window.TOJFilms.getMeta) await window.TOJFilms.getMeta();
      d = await t.api("/api/studio-learn/monthly/" + encodeURIComponent(slug));
    } catch (e) {
      if (e.stale) throw e;
      return t.show(null, '<div class="screen">' + back + '<h1 class="title sm">Couldn\'t open it</h1><p class="body err">' + h(why(e)) + "</p></div>");
    }
    var ticked = {};
    d.suggestions.forEach(function (x) { ticked["suggestions:" + x.id] = true; });
    d.wraps.forEach(function (x) { ticked["wraps:" + x.id] = true; });
    d.rules.forEach(function (x) { ticked["labels:" + x.label] = true; });
    // The brief as you've edited it, kept across repaints and ticks: only
    // "Build it again from the ticks" replaces it.
    var edited = false, briefText = "", tickedSinceEdit = false;
    var declining = null, declineNote = "";
    // A declined item whose line couldn't be found in an edited brief: Start
    // waits until it's built again, or you say it's out.
    var mustCheck = null;
    // Ticked items whose lines aren't in the brief as written: asked at Start.
    var missingAsked = false;
    function tick(key, title, body, sub, declinable) {
      return '<div class="card tight" style="gap:6px"><label class="row" style="gap:10px;align-items:flex-start;cursor:pointer"><input type="checkbox" class="switch" data-tick="' + h(key) + '"' + (ticked[key] ? " checked" : "") + ' style="width:22px;height:22px;margin-top:2px"><div class="grow"><div class="name" style="font-size:14.5px">' + h(title) + '</div><p class="body" style="margin:2px 0 0;font-size:14px;white-space:pre-line">' + h(body) + "</p>" + (sub ? '<div class="sub">' + h(sub) + "</div>" : "") + "</div></label>" +
        (declinable ? (declining === key
          ? '<div class="row" style="gap:8px"><label class="sr" for="decNote">Why not</label><input class="input grow" id="decNote" maxlength="300" placeholder="Why not (a few words)" value="' + h(declineNote) + '"><button type="button" class="btn small" data-decline-go="' + h(key) + '">Decline</button><button type="button" class="btn ghost small" id="decCancel">Not now</button></div>'
          : '<div class="btn-row" style="justify-content:flex-end"><button type="button" class="btn ghost small" data-decline="' + h(key) + '" style="flex:0 0 auto">Decline…</button></div>') : "") + "</div>";
    }
    function heldNote() {
      var hw = (d.held && d.held.wraps) || [], hs = (d.held && d.held.suggestions) || 0, hr = (d.held && d.held.rules) || 0;
      if (!hw.length && !hs && !hr) return "";
      var bits = [];
      if (hw.length) bits.push(hw.length + (hw.length === 1 ? " wrap-up" : " wrap-ups"));
      if (hs) bits.push(hs + (hs === 1 ? " suggested edit" : " suggested edits"));
      if (hr) bits.push(hr + (hr === 1 ? " rule in the making" : " rules in the making"));
      var one = hw.length + hs + hr === 1;
      return '<div class="card tight" style="gap:8px"><p class="body" style="font-size:14px;margin:0">' + h("Held back: " + bits.join(", ") + (one ? " names" : " name") + " someone on a card added since, so " + (one ? "it stays" : "they stay") + " out of the brief." + (hw.length ? " Edit " + (hw.length === 1 ? "the wrap-up on its film:" : "the wrap-ups on their films:") : "")) + "</p>" +
        (hw.length ? '<div class="btn-row">' + hw.slice(0, 6).map(function (w) { return '<a class="btn soft small" href="#film-wraps/' + h(w.film.id) + '">' + h(fmt(d.kit.slug, w.film.format) + " · " + w.film.athlete_id) + "</a>"; }).join("") + "</div>" : "") + "</div>";
    }
    function state() {
      if (d.running) return '<div class="card tight"><p class="body" style="font-size:14px;margin:0">This month\'s refresh is running (started ' + h(day(d.running.started_at)) + '). What it was given stays as it read it until it ends.</p><div class="btn-row"><a class="btn soft small" href="#run/' + h(d.running.run_id) + '">Open that run</a></div></div>';
      if (d.done_this_month && d.last_monthly) return '<div class="card tight"><p class="body" style="font-size:14px;margin:0">This month\'s refresh ran ' + h(day(d.last_monthly.started_at)) + (d.last_monthly.outcome === "no_changes" ? " and found nothing to change" : "") + '. What came in since waits for next month, or start another.</p><div class="btn-row"><a class="btn soft small" href="#run/' + h(d.last_monthly.run_id) + '">Open that run</a></div></div>';
      if (d.last_monthly && d.last_monthly.month === d.month && d.last_monthly.outcome === "failed") return '<div class="card tight"><p class="body" style="font-size:14px;margin:0">The refresh started ' + h(day(d.last_monthly.started_at)) + " didn't save a draft, so everything it was given is still here.</p></div>";
      return "";
    }
    function paint() {
      var c = compose(d, ticked);
      var text = edited ? briefText : c.text;
      var any = c.used.wraps.length + c.used.suggestions.length + c.used.labels.length;
      var sec = function (title, items, body) { return items.length ? '<section class="sec"><h2 class="sec-h">' + h(title + " (" + items.length + ")") + "</h2>" + body + "</section>" : ""; };
      var startLabel = d.done_this_month ? "Start another refresh this month" : "Start the monthly refresh";
      t.show(null,
        '<div class="screen">' + back +
        '<div><p class="kicker">Monthly refresh · ' + h(monthName(d.month)) + '</p><h1 class="title sm">' + h(d.kit.title) + "</h1>" +
        '<p class="lede" style="font-size:15px">What the team learned' + (d.last_ran ? " since " + h(day(d.last_ran.started_at)) : "") + ', as a brief for the Kit Refresher. Untick what shouldn\'t go in. It makes a draft, and nothing changes until Kyron approves it. What\'s ticked is folded in once it saves a draft; if it doesn\'t, it all stays here.</p></div>' +
        state() + heldNote() +
        sec("Suggested edits", d.suggestions, d.suggestions.map(function (x) { return tick("suggestions:" + x.id, x.column_name + " › " + x.card_title, x.suggestion, (x.why ? "Why: " + x.why + " · " : "") + String(x.created_by || "").replace(/@.*/, "") + " · " + day(x.created_at), true); }).join("")) +
        sec("Wrap-ups", d.wraps, d.wraps.map(function (x) { return tick("wraps:" + x.id, fmt(d.kit.slug, x.film.format) + " · " + x.film.athlete_id, "Worked: " + x.worked + (x.missed ? "\nMissed: " + x.missed : "") + (x.change ? "\nChange: " + x.change : ""), (x.card_title ? "Card: " + x.card_title + " · " : "") + String(x.created_by || "").replace(/@.*/, "") + " · " + day(x.created_at), false); }).join("")) +
        sec("Rules in the making", d.rules, d.rules.map(function (x) { return tick("labels:" + x.label, "“" + x.label + "”", x.notes + " review notes on " + x.films + (x.films === 1 ? " film" : " films") + (x.declined_before ? ", declined once before" : ""), (x.samples || []).slice(0, 2).join(" · "), true); }).join("")) +
        (!d.suggestions.length && !d.wraps.length && !d.rules.length ? '<p class="empty">Nothing new since the last refresh: no wrap-ups, suggested edits or rules in the making.</p>' : "") +
        '<section class="sec"><h2 class="sec-h">Gear</h2><div class="card tight"><p class="body" style="font-size:14px;margin:0">' + (d.last_gear ? "The last gear re-check was started " + h(day(d.last_gear.started_at)) + "." : "No gear re-check yet.") + '</p><div class="btn-row"><a class="btn soft small" href="#new/gear">Re-check gear</a></div></div></section>' +
        '<div class="field"><label class="label" for="mBrief">The brief <small>(edit anything)</small></label><textarea class="textarea mono" id="mBrief" style="min-height:220px">' + h(text) + "</textarea>" +
        (edited ? '<p class="sub" style="margin:0">' + h(tickedSinceEdit ? "Your edits are kept, so ticking doesn't change the brief now. Build it again to put the ticks in." : "Edited by hand. Ticking won't change it now.") + '</p><button type="button" class="btn ghost small" id="mRebuild">Build it again from the ticks</button>' : "") +
        (c.left ? '<p class="sub" style="margin:0">' + h(c.left + " didn't fit in one brief: they stay for next month.") + "</p>" : "") + "</div>" +
        (mustCheck ? '<div class="card tight" role="alert" style="gap:8px"><p class="body" style="margin:0;font-size:14px">' + h("You declined " + mustCheck.title + ", and your edited brief may still ask for it. Build the brief again from the ticks, or take it out by hand and say so.") + '</p><div class="btn-row"><button type="button" class="btn small" id="mCheckRebuild">Build it again from the ticks</button><button type="button" class="btn ghost small" id="mCheckOut">It\'s out of the brief</button></div></div>' : "") +
        '<div id="mMissing"></div><p id="mMsg" class="body" role="status"></p></div>' +
        '<div class="dock"><div class="dock-inner"><button type="button" class="btn block" id="mStart"' + (any && !d.running && !mustCheck ? "" : " disabled") + ">" + h(startLabel) + '</button><span class="note">Makes a draft. Nothing changes until it\'s approved.</span></div></div>');
      wire();
    }
    function rebuild() { edited = false; briefText = ""; tickedSinceEdit = false; mustCheck = null; missingAsked = false; paint(); }
    function wire() {
      Array.prototype.forEach.call(document.querySelectorAll("[data-tick]"), function (b) {
        b.addEventListener("change", function () { ticked[b.dataset.tick] = b.checked; missingAsked = false; if (edited) tickedSinceEdit = true; paint(); });
      });
      var area = document.getElementById("mBrief");
      area.addEventListener("input", function () {
        briefText = area.value;
        missingAsked = false;
        if (!edited) { edited = true; var pos = area.selectionStart; paint(); var a2 = document.getElementById("mBrief"); a2.focus(); try { a2.setSelectionRange(pos, pos); } catch (e) { /* fine */ } }
      });
      var rb = document.getElementById("mRebuild");
      if (rb) rb.addEventListener("click", rebuild);
      var cr = document.getElementById("mCheckRebuild");
      if (cr) cr.addEventListener("click", rebuild);
      if (mustCheck && cr && cr.scrollIntoView) cr.scrollIntoView({ block: "center" });
      var co = document.getElementById("mCheckOut");
      if (co) co.addEventListener("click", function () { mustCheck = null; paint(); });
      var note = document.getElementById("decNote");
      if (note) note.addEventListener("input", function () { declineNote = note.value; });
      var dc = document.getElementById("decCancel");
      if (dc) dc.addEventListener("click", function () { declining = null; paint(); });
      Array.prototype.forEach.call(document.querySelectorAll("[data-decline]"), function (b) {
        b.addEventListener("click", function () { if (declining !== b.dataset.decline) declineNote = ""; declining = b.dataset.decline; paint(); var n = document.getElementById("decNote"); if (n) n.focus(); });
      });
      Array.prototype.forEach.call(document.querySelectorAll("[data-decline-go]"), function (b) {
        b.addEventListener("click", async function () {
          var key = b.dataset.declineGo, note = declineNote.trim();
          // Its line as the brief has it now, to take it out of an edited one.
          var line = compose(d, ticked).lines[key] || null;
          var title = key.indexOf("suggestions:") === 0
            ? (function (x) { return x ? "the suggested edit to " + x.card_title : "a suggested edit"; })(d.suggestions.find(function (x) { return "suggestions:" + x.id === key; }))
            : "the rule “" + key.slice(7) + "”";
          b.disabled = true;
          try {
            if (key.indexOf("suggestions:") === 0) {
              await t.post("/api/studio-learn/suggestions/" + encodeURIComponent(key.slice(12)) + "/decline", { note: note });
              d.suggestions = d.suggestions.filter(function (x) { return "suggestions:" + x.id !== key; });
            } else {
              await t.post("/api/studio-learn/labels/decline", { slug: d.kit.slug, label: key.slice(7), note: note });
              d.rules = d.rules.filter(function (x) { return "labels:" + x.label !== key; });
            }
            delete ticked[key];
            declining = null; declineNote = "";
            if (edited && line) {
              // Out of your edited brief too: its line as written, or ask.
              var out = withoutLine(briefText, line);
              if (out != null) briefText = out;
              else mustCheck = { key: key, title: title };
            }
            paint();
            t.toast(edited && line && !mustCheck ? "Declined, and taken out of the brief." : "Declined, with your reason.");
          } catch (e) { b.disabled = false; say("mMsg", why(e), true); }
        });
      });
      document.getElementById("mStart").addEventListener("click", async function () {
        var btn = this;
        var c = compose(d, ticked);
        var brief = document.getElementById("mBrief").value.trim();
        // What's ticked but not in the brief as written would be folded in
        // without the run reading it: asked once.
        var missing = Object.keys(c.lines).filter(function (k) { return brief.indexOf(c.lines[k]) < 0; });
        if (missing.length && !missingAsked) {
          document.getElementById("mMissing").innerHTML = '<div class="card tight" role="alert" style="gap:8px"><p class="body" style="margin:0;font-size:14px">' + h(missing.length + (missing.length === 1 ? " ticked item isn't" : " ticked items aren't") + " in the brief as written. It would be folded in without the Kit Refresher reading it. Build the brief again, untick it, or start anyway.") + '</p><div class="btn-row"><button type="button" class="btn small" id="mMissRebuild">Build it again from the ticks</button><button type="button" class="btn ghost small" id="mMissGo">Start anyway</button></div></div>';
          document.getElementById("mMissRebuild").addEventListener("click", rebuild);
          document.getElementById("mMissGo").addEventListener("click", function () { missingAsked = true; document.getElementById("mMissing").innerHTML = ""; btn.click(); });
          // Where it can be seen, above the Start button.
          var box = document.getElementById("mMissing");
          if (box.scrollIntoView) box.scrollIntoView({ block: "center" });
          document.getElementById("mMissGo").focus({ preventScroll: true });
          return;
        }
        btn.disabled = true; btn.textContent = "Starting…";
        try {
          var body = { role: "kit-refresher", slug: d.kit.slug, brief: brief, purpose: "monthly", sources: c.used };
          if (d.done_this_month) body.again = true;
          var r = await t.post("/api/studio-agents/run", body);
          t.go("#run/" + r.run_id);
        } catch (e) {
          btn.disabled = false; btn.textContent = d.done_this_month ? "Start another refresh this month" : "Start the monthly refresh";
          say("mMsg", (e.data && e.data.error === "brief_too_long" ? "The brief is over " + e.data.max + " characters: untick some, or shorten it." : why(e)), true);
          var m = document.getElementById("mMsg");
          if (m && m.scrollIntoView) m.scrollIntoView({ block: "center" });
        }
      });
    }
    paint();
  }

  // ── Today ────────────────────────────────────────────────────────────
  async function todayParts() {
    var d = await T().api("/api/studio-learn/today");
    var needs = "", count = 0;
    (d.monthly || []).forEach(function (m) {
      var bits = [];
      if (m.counts.wraps) bits.push(m.counts.wraps + (m.counts.wraps === 1 ? " wrap-up" : " wrap-ups"));
      if (m.counts.suggestions) bits.push(m.counts.suggestions + (m.counts.suggestions === 1 ? " suggested edit" : " suggested edits"));
      if (m.counts.rules) bits.push(m.counts.rules + (m.counts.rules === 1 ? " rule in the making" : " rules in the making"));
      needs += '<article class="card"><div class="row"><div class="grow"><div class="name">This month\'s kit refresh</div><div class="sub">' + h(m.title + ": " + bits.join(", ")) + '</div></div><span class="badge gold">Due</span></div><div class="btn-row"><a class="btn soft" href="#monthly/' + h(m.slug) + '">Open the month\'s brief</a></div></article>';
      count++;
    });
    if (d.gear && d.gear.due) {
      needs += '<article class="card"><div class="row"><div class="grow"><div class="name">Gear re-check due</div><div class="sub">' + h(d.gear.last_at ? "The last one was " + day(d.gear.last_at) + "." : "There hasn't been one yet.") + '</div></div></div><div class="btn-row"><a class="btn soft" href="#new/gear">Re-check gear</a></div></article>';
      count++;
    }
    return { needs: needs, count: count };
  }

  window.TOJLearn = { todayParts: todayParts };
  window.TOJScreens = Object.assign(window.TOJScreens || {}, { "film-wraps": wraps, monthly: monthly });
})();
