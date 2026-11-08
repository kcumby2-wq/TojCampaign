/* Studio films in the TOJ app: a room for every film made from a kit. The API
 * is routes/studio-films.js (migration 039). Registers screens for app.js:
 *
 *   #films                     the films (#films/archived for archived ones)
 *   #film-new                  start a film from a kit
 *   #film/<id>                 the room: the kit's ten steps, clearance cards,
 *                              cuts and their review links, posts, history
 *   #film-edit/<id>            details and the board's structured parts
 *   #film-person/<id>/<pid>    a clearance card (<pid> "new" for a new one)
 *   #film-cut/<id>             upload a cut for review, with who's in it
 *   #film-takedowns            open takedowns and their 72-hour clocks
 *   #film-tools                the tools that touch footage, off until approved
 *
 * Names and contacts show on cards and nowhere else: titles and file names
 * carry the athlete ID.
 */
(function () {
  "use strict";
  var T = function () { return window.TOJ; };
  var h = function (s) { return T().h(s); };
  var MSG = {
    not_your_step: "That step is someone else's: its owner or the producer finishes it.",
    producer_only: "Only the producer (an approver or Kyron) can do that.",
    owner_only: "Only Kyron can do that.",
    tool_off: "Review copies are off until Kyron approves storing them (Studio → Films → Tool approvals).",
    title_has_name: "Titles never carry a name. Use the athlete ID instead.",
    file_name_has_name: "File names never carry a name. Use the athlete ID, the kit's way.",
    too_big: "That file is over the size limit for review copies. Export the review copy at 720p.",
    changed_meanwhile: "It changed while you were looking. Open it again.",
    already_done: "That's already done.",
    no_approved_kit: "That kit has no approved version yet.",
    email_failed: "The email didn't go, so no link was made. Try again in a minute.",
    email_not_set_up: "The app can't send email yet (Render's email settings), so no link was made.",
    too_many_links_today: "That address has had 20 links today. Try tomorrow, or call them.",
    no_reviewer: "That card doesn't say who approves the cut.",
    exists: "There's already a live link for that cut and reviewer.",
    not_uploaded: "The file isn't in storage yet. Try the upload again.",
    film_closed: "This film is closed.",
    confirm_first: "Confirm first.",
    nothing_to_pull: "Nobody with that code is on an open card.",
    no_live_link: "That link isn't live anymore.",
    not_approved: "Only an approval can be taken back.",
    already_removed: "Already marked down.",
    storage_unavailable: "The server can't reach its database or storage right now.",
    not_found: "Not found. It may have been removed.",
  };
  function why(e) {
    var d = e && e.data;
    if (d && d.error === "refused" && d.reason) return d.reason.charAt(0).toUpperCase() + d.reason.slice(1) + ".";
    if (d && d.error === "gaps") return "Still needed: " + (d.gaps || []).join("; ") + ".";
    if (d && d.error === "invalid" && d.fields) return d.fields.map(function (f) { return MSG[f] || "Check " + f.replace(/_/g, " "); }).join(" ");
    return (d && MSG[d.error]) || (e && e.message) || "That didn't work.";
  }
  var meta = null;
  async function getMeta() { if (!meta) meta = await T().api("/api/studio-films/meta"); return meta; }
  function tpl(slug) { return meta && meta.templates[slug || "same-work"]; }
  function fmtLabel(slug, f) { var t = tpl(slug); return t && t.formats[f] ? t.formats[f].label : f; }
  function laneLabel(slug, l) { var t = tpl(slug); return t && t.lanes[l] ? t.lanes[l].label : l; }
  function ratio(r) { return String(r || "").replace("x", ":"); }
  function when(iso) { if (!iso) return ""; var d = new Date(iso); return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
  function left(iso) {
    var ms = new Date(iso).getTime() - Date.now();
    var hrs = Math.round(ms / 3600000);
    return { late: ms < 0, text: ms < 0 ? "Late by " + Math.abs(hrs) + " h" : hrs + " h left", tight: ms < 12 * 3600000 };
  }
  function badge(text, kind) { return text ? '<span class="badge ' + (kind || "") + '">' + h(text) + "</span>" : ""; }
  function msgBox(id) { return '<p id="' + id + '" class="body" role="status"></p>'; }
  function say(id, text, bad) { var el = document.getElementById(id); if (el) el.innerHTML = '<span class="' + (bad ? "err" : "") + '">' + h(text) + "</span>"; }
  function armed(btn, label, fn) {
    btn.addEventListener("click", async function () {
      if (!btn.dataset.armed) { btn.dataset.armed = "1"; var old = btn.textContent; btn.textContent = label; setTimeout(function () { delete btn.dataset.armed; btn.textContent = old; }, 4000); return; }
      btn.disabled = true;
      try { await fn(); } catch (e) { btn.disabled = false; T().toast(why(e)); }
    });
  }
  function loading(back) { T().show("studio", '<div class="screen">' + back + '<div class="spin"></div></div>'); }
  function failed(back, e) { T().show("studio", '<div class="screen">' + back + '<h1 class="title sm">Couldn\'t open it</h1><p class="body err">' + h(why(e)) + "</p></div>"); }
  function guard() { if (!T().atLeast("member") || !T().hasTool("studio")) { T().go("#studio"); return false; } return true; }

  // ── The films ────────────────────────────────────────────────────────
  async function films(arg) {
    if (!guard()) return;
    var t = T(), back = t.backBtn("#studio", "Studio");
    loading(back);
    var d;
    try { await getMeta(); d = await t.api("/api/studio-films/films" + (arg === "archived" ? "?archived=1" : "")); } catch (e) { if (e.stale) throw e; return failed(back, e); }
    var row = function (f) {
      var w = f.where || {};
      var b = w.state === "pulled" ? badge("Consent pulled", "bad") : w.state === "published" ? badge("Published", "ok") : w.state === "archived" ? badge("Archived") : badge(w.label, "gold");
      return '<a class="li" href="#film/' + h(f.id) + '"><div class="grow"><div class="name" style="font-size:15.5px">' + h(f.title) + '</div><div class="sub">' + h([fmtLabel(f.kit_slug, f.format), laneLabel(f.kit_slug, f.lane), f.athlete_id].join(" · ")) + "</div>" +
        (w.state === "active" ? '<div class="sub">' + f.done + " of 10 steps · waiting on " + h(w.waiting_on) + "</div>" : "") + "</div>" + b + t.I.chev + "</a>";
    };
    var list = d.films || [];
    var live = list.filter(function (f) { return f.where && f.where.state !== "pulled"; });
    var pulled = list.filter(function (f) { return f.where && f.where.state === "pulled"; });
    var tools = (meta.tools || []).filter(function (x) { return x.is_on; }).length;
    t.show("studio",
      '<div class="screen">' + back +
      '<div class="head"><div><p class="kicker">Studio</p><h1 class="title">' + (arg === "archived" ? "Archived films" : "Films") + "</h1></div>" + (arg === "archived" ? "" : '<a class="btn small soft" href="#film-new">' + t.I.plus.replace("<svg", '<svg width="16" height="16"') + "Start a film</a>") + "</div>" +
      (arg === "archived" ? "" : '<p class="lede">Each film runs the kit\'s ten steps, each with its owner. Cards are cleared before the shoot, speakers approve their own cut, and nothing goes out without the final sign-off.</p>') +
      (live.length ? '<div class="list">' + live.map(row).join("") + "</div>" : '<p class="empty">' + (arg === "archived" ? "No archived films." : "No films yet. Start one from the Same Work kit.") + "</p>") +
      (pulled.length ? '<section class="sec"><h2 class="sec-h">Consent pulled</h2><div class="list">' + pulled.map(row).join("") + "</div></section>" : "") +
      '<div class="list">' +
      (meta.can.producer ? '<a class="li" href="#film-takedowns"><div class="grow"><div class="name" style="font-size:15px">Takedowns</div><div class="sub">The 72-hour clock when consent is pulled</div></div>' + t.I.chev + "</a>" : "") +
      '<a class="li" href="#film-tools"><div class="grow"><div class="name" style="font-size:15px">Tool approvals</div><div class="sub">' + tools + " of " + (meta.tools || []).length + " on · tools that touch footage start off</div></div>" + t.I.chev + "</a>" +
      (arg === "archived" ? '<a class="li" href="#films"><div class="grow name" style="font-size:15px">Films in progress</div>' + t.I.chev + "</a>" : '<a class="li" href="#films/archived"><div class="grow name" style="font-size:15px">Archived films</div>' + t.I.chev + "</a>") +
      "</div></div>");
  }

  // ── Start a film ─────────────────────────────────────────────────────
  async function filmNew() {
    if (!guard()) return;
    var t = T(), back = t.backBtn("#films", "Films");
    loading(back);
    try { await getMeta(); } catch (e) { if (e.stale) throw e; return failed(back, e); }
    var tp = tpl("same-work");
    var lanes = Object.keys(tp.lanes), formats = Object.keys(tp.formats);
    var s = { lane: "youth", format: "hero" };
    function draw() {
      t.show(null,
        '<div class="screen">' + back + '<h1 class="title sm">Start a film</h1><p class="lede">From the ' + h(tp.name) + ' kit. The title is a working title: never a person\'s name. Use the athlete ID.</p>' +
        '<div class="field"><label class="label" for="fTitle">Working title</label><input class="input" id="fTitle" maxlength="120" placeholder="A0142 hero"></div>' +
        '<div class="field"><span class="label">Lane</span><div class="seg" role="group" aria-label="Lane">' + lanes.map(function (l) { return '<button type="button" data-lane="' + l + '" aria-pressed="' + (s.lane === l) + '">' + h(tp.lanes[l].label) + "</button>"; }).join("") + "</div></div>" +
        '<div class="field"><label class="label" for="fFormat">Format</label><select class="input" id="fFormat">' + formats.map(function (f) { return '<option value="' + f + '"' + (s.format === f ? " selected" : "") + ">" + h(tp.formats[f].label + " · " + tp.formats[f].spec) + "</option>"; }).join("") + "</select></div>" +
        '<div class="field"><label class="label" for="fAthlete">Athlete ID</label><input class="input" id="fAthlete" maxlength="20" placeholder="A0142" autocapitalize="characters"></div>' +
        '<div class="field"><label class="label" for="fStory">One-sentence story <small>(the brief needs it)</small></label><textarea class="textarea" id="fStory" maxlength="300" style="min-height:80px" placeholder="He ran this drill in 2017. He runs it on Sundays now."></textarea></div>' +
        '<div class="field"><label class="label" for="fPost">Post date <small>(optional)</small></label><input class="input" id="fPost" type="date"></div>' +
        (meta.can.producer ? '<div class="field"><label class="label" for="fDir">Director <small>(their email on the team)</small></label><input class="input" id="fDir" type="email" autocomplete="off"></div><div class="field"><label class="label" for="fEd">Editor</label><input class="input" id="fEd" type="email" autocomplete="off"></div>' : "") +
        msgBox("newMsg") + "</div>" +
        '<div class="dock"><div class="dock-inner"><button type="button" class="btn block" id="startFilm">Start the film</button><span class="note">It starts at the brief. Ten steps, in the kit\'s order.</span></div></div>');
      document.querySelectorAll("[data-lane]").forEach(function (b) { b.addEventListener("click", function () { keep(); s.lane = b.dataset.lane; draw(); restore(); }); });
      document.getElementById("startFilm").addEventListener("click", start);
    }
    var kept = {};
    function keep() { ["fTitle", "fFormat", "fAthlete", "fStory", "fPost", "fDir", "fEd"].forEach(function (id) { var el = document.getElementById(id); if (el) kept[id] = el.value; }); s.format = kept.fFormat || s.format; }
    function restore() { Object.keys(kept).forEach(function (id) { var el = document.getElementById(id); if (el && id !== "fFormat") el.value = kept[id]; }); }
    async function start() {
      keep();
      var btn = document.getElementById("startFilm");
      btn.disabled = true;
      try {
        var body = { kit_slug: "same-work", title: kept.fTitle, lane: s.lane, format: kept.fFormat, athlete_id: kept.fAthlete, one_sentence: kept.fStory || null, post_date: kept.fPost || null };
        if (meta.can.producer) { body.director_email = kept.fDir || null; body.editor_email = kept.fEd || null; }
        var d = await t.post("/api/studio-films/films", body);
        T().go("#film/" + d.film.id);
      } catch (e) { btn.disabled = false; say("newMsg", why(e), true); }
    }
    draw();
  }

  // ── The room ─────────────────────────────────────────────────────────
  var STEP_OWNER = { producer: "Producer", director: "Director", editor: "Editor", owner: "Kyron" };
  var EVENT = {
    film_created: "started the film", film_archived: "archived it", film_unarchived: "brought it back", film_pulled: "pulled the film (consent)",
    step_done: "finished", step_reopened: "reopened", second_yes: "said yes", person_added: "added a card for", person_cleared: "cleared the card for",
    person_uncleared: "uncleared the card for", consent_pulled: "recorded consent pulled for", cut_added: "uploaded", cut_ready: "made the review copy of",
    cut_failed: "couldn't make the review copy of", review_asked: "sent a review link to", review_approved: "approved the cut", review_changes: "asked for a change",
    review_link_cancelled: "cancelled the review link for", review_withdrawn: "recorded the yes taken back by", posted: "recorded a post on", post_removed: "took down the post on",
    takedown_opened: "opened a takedown for", takedown_item_done: "took down", takedown_closed: "closed the takedown for", note: "noted",
  };
  function approvedCut(c, people, reviews) {
    if (c.status !== "ready") return false;
    var speakers = people.filter(function (p) { return p.speaker && (c.people || []).indexOf(p.id) >= 0; });
    if (!speakers.length) return false;
    if (people.some(function (p) { return (c.people || []).indexOf(p.id) >= 0 && (!p.cleared_at || p.consent_pulled_at); })) return false;
    return speakers.every(function (p) { return reviews.some(function (r) { return r.cut_id === c.id && r.person_id === p.id && r.state === "approved"; }); });
  }
  async function film(id) {
    if (!guard()) return;
    var t = T(), back = t.backBtn("#films", "Films");
    loading(back);
    var d;
    try { await getMeta(); d = await t.api("/api/studio-films/films/" + encodeURIComponent(id)); } catch (e) { if (e.stale) throw e; return failed(back, e); }
    var f = d.film, w = d.where, people = d.people, cuts = d.cuts, reviews = d.reviews, posts = d.posts;
    var closed = !!(f.pulled_at || f.archived_at);
    var current = d.steps.find(function (s) { return s.status === "todo"; });
    var lastDone = d.steps.filter(function (s) { return s.status === "done"; }).slice(-1)[0];
    var codeOf = function (pid) { var p = people.find(function (x) { return x.id === pid; }); return p ? p.person_code : "?"; };
    var approved = cuts.filter(function (c) { return approvedCut(c, people, reviews); });
    var reviewOn = (meta.tools || []).some(function (x) { return x.tool === "review_copies" && x.is_on; });

    var head = '<div><p class="kicker">' + h([d.template ? d.template.name : f.kit_slug, fmtLabel(f.kit_slug, f.format), laneLabel(f.kit_slug, f.lane), f.athlete_id].join(" · ")) + '</p><h1 class="title sm">' + h(f.title) + "</h1>" +
      (f.one_sentence ? '<p class="lede" style="font-size:15px">' + h(f.one_sentence) + "</p>" : "") + "</div>" +
      '<div class="btn-row" style="gap:8px">' + (w.state === "active" ? badge("Next: " + w.label + " · " + w.waiting_on, "gold") : w.state === "pulled" ? badge("Consent pulled", "bad") : w.state === "published" ? badge("Published", "ok") : badge("Archived")) +
      (f.post_date ? badge("Posts " + new Date(f.post_date + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })) : "") + "</div>" +
      (closed ? "" : '<div class="btn-row"><a class="btn soft small" href="#film-edit/' + h(f.id) + '">Details and board</a></div>');
    var pulledBox = f.pulled_at ? '<article class="card" style="border-color:#5A3A33"><div class="name">Consent was pulled</div><p class="body">Nothing more goes out. Every post of this film is on the takedown list, with the 72-hour clock.' + (d.can.producer ? "" : " The producer is on it.") + "</p>" + (d.can.producer ? '<div class="btn-row"><a class="btn small" href="#film-takedowns">Open takedowns</a></div>' : "") + "</article>" : "";

    // The ten steps.
    var steps = d.steps.map(function (s) {
      var isCur = current && s.step === current.step && !closed;
      var body = "<b>" + h(s.label) + "</b><span>" + h(STEP_OWNER[s.owner] || s.owner) + (s.owner === "producer" && s.step === "final_signoff" && f.second_yes_label ? " and " + h(f.second_yes_label) : "") + " · " + h(s.carries) + "</span>";
      if (s.status === "done") body += '<span style="color:var(--ok)">Done by ' + h(s.done_by) + " · " + h(t.ago(s.done_at)) + (s.cut_id ? " · cut " + h(cutLabel(cuts.find(function (c) { return c.id === s.cut_id; }))) : "") + "</span>" + (s.note ? "<span>" + h(s.note) + "</span>" : "") + (s.second_yes_at ? "<span>" + h(s.second_yes_by) + ": " + h(s.second_yes_note || "yes") + "</span>" : "");
      if (isCur) {
        body += "<span><i>Done when:</i> " + h(s.done_when) + "</span>";
        if (s.checklist && s.checklist.length) body += '<details><summary class="sub" style="cursor:pointer;min-height:32px;display:flex;align-items:center">' + h(s.checklist_title) + " (" + s.checklist.length + ")</summary><ul class=\"body\" style=\"margin:6px 0 0;padding-left:18px;font-size:13.5px\">" + s.checklist.map(function (x) { return "<li>" + h(x) + "</li>"; }).join("") + "</ul></details>";
        if (s.can_finish) body += stepForm(s);
        else body += '<span class="warnc">Waiting on ' + h(w.waiting_on) + ".</span>";
      }
      if (lastDone && s.step === lastDone.step && d.can.producer && !closed && s.step !== "publish") {
        body += '<details style="margin-top:4px"><summary class="sub" style="cursor:pointer;min-height:32px;display:flex;align-items:center">Reopen this step</summary><div class="field" style="margin-top:6px"><input class="input" id="reopenWhy" maxlength="500" placeholder="Why (for the history)"><button type="button" class="btn danger small" id="reopen" data-step="' + h(s.step) + '">Reopen ' + h(s.label) + "</button></div></details>";
      }
      return '<li><span class="s' + (s.status === "done" ? " done" : "") + '"></span><div class="stepbody">' + body + "</div></li>";
    }).join("");
    function stepForm(s) {
      var out = '<div class="field" style="margin-top:6px">';
      if (s.step === "speaker_review") {
        out += approved.length ? '<select class="input" id="stepCut">' + approved.map(function (c) { return '<option value="' + h(c.id) + '">' + h(cutLabel(c)) + "</option>"; }).join("") + "</select>" : '<span class="warnc">No cut is approved by every speaker in it yet (Cuts, below).</span>';
      }
      if (s.step === "final_signoff" && f.second_yes_label && !s.second_yes_at) {
        out += '<input class="input" id="secondYes" maxlength="300" placeholder="How ' + h(f.second_yes_label) + ' said yes (text, email, date)"><button type="button" class="btn soft small" id="recordSecond">Record ' + h(f.second_yes_label) + "'s yes</button>";
      }
      if (s.step === "publish" && !posts.some(function (p) { return !p.removed_at; })) out += '<span class="warnc">Record where it went out first (below).</span>';
      out += '<input class="input" id="stepNote" maxlength="500" placeholder="A note (optional)"><button type="button" class="btn small" id="stepDone" data-step="' + h(s.step) + '">Mark ' + h(s.label) + " done</button>";
      return out + "</div>";
    }
    function cutLabel(c) { return c ? fmtLabel(f.kit_slug, c.format) + " " + ratio(c.ratio) + " v" + c.version : "?"; }

    // The cards.
    var cards = people.map(function (p) {
      var state = p.consent_pulled_at ? badge("Consent pulled", "bad") : p.cleared_at ? badge("Cleared", "ok") : badge("Not cleared", "warn");
      var tags = [p.role, p.is_minor ? "minor" : "", p.texas_youth ? "Texas youth: unidentifiable" : "", p.speaker ? "speaker" : ""].filter(Boolean).join(" · ");
      var cov = p.covers || {};
      var covers = "Release covers: " + (["face", "name", "jersey", "voice"].filter(function (k) { return cov[k]; }).join(", ") || "nothing identifying") + ((cov.formats || []).length ? " · " + cov.formats.map(function (x) { return fmtLabel(f.kit_slug, x); }).join(", ") : "");
      var who = p.reviewer_email ? (p.reviewer_relation === "self" ? "Approves their own cut" : "Approved by " + (p.reviewer_relation === "guardian" ? "legal guardian" : "parent") + " " + p.reviewer_name) + " · " + p.reviewer_email : "";
      return '<article class="card tight"><div class="row"><div class="grow"><div class="name" style="font-size:15px">' + h(p.name) + ' <span class="sub">' + h(p.person_code) + '</span></div><div class="sub">' + h(tags) + "</div></div>" + state + "</div>" +
        '<p class="body" style="font-size:13.5px">' + h(covers) + (who ? "<br>" + h(who) : "") + (p.cleared_at ? "<br>Cleared by " + h(p.cleared_by) + " · " + h(t.ago(p.cleared_at)) : "") + (p.gaps && p.gaps.length && !p.cleared_at ? '<br><span class="warnc">Still needed: ' + h(p.gaps.join("; ")) + "</span>" : "") + "</p>" +
        (closed || p.consent_pulled_at ? "" : '<div class="btn-row"><a class="btn ghost small" href="#film-person/' + h(f.id) + "/" + h(p.id) + '">Edit card</a>' +
          (d.can.producer && !p.cleared_at && !(p.gaps || []).length ? '<button type="button" class="btn small" data-clear="' + h(p.id) + '" data-seen="' + h(p.updated_at) + '">Clear it</button>' : "") + "</div>") +
        (d.can.producer && !p.consent_pulled_at ? '<details><summary class="sub" style="cursor:pointer;min-height:32px;display:flex;align-items:center">Consent pulled?</summary><div class="field" style="margin-top:6px"><p class="body" style="font-size:13.5px">Every film ' + h(p.person_code) + ' is in stops, every live post goes on the takedown list, and the 72-hour clock starts. It can\'t be undone.</p><input class="input" data-pullnote="' + h(p.person_code) + '" maxlength="500" placeholder="How it came in (phone call, email)"><button type="button" class="btn danger small" data-pull="' + h(p.person_code) + '">Consent pulled: start the takedown</button></div></details>' : "") +
        "</article>";
    }).join("");

    // The cuts and their review links.
    var cutCards = cuts.map(function (c) {
      var st = c.status === "ready" ? (approvedCut(c, people, reviews) ? badge("Approved", "ok") : badge("Ready for review", "gold")) : c.status === "failed" ? badge("Failed", "bad") : badge("Making the review copy", "warn");
      var inIt = (c.people || []).map(codeOf).join(", ") || "nobody listed";
      var speakers = people.filter(function (p) { return p.speaker && (c.people || []).indexOf(p.id) >= 0; });
      var rows = speakers.map(function (p) {
        var rs = reviews.filter(function (r) { return r.cut_id === c.id && r.person_id === p.id; });
        var last = rs[rs.length - 1];
        var stateText = !last ? "Not sent" : { live: "Link out · until " + when(last.expires_at), expired: "Link expired", cancelled: "Link cancelled", approved: "Approved by " + last.decided_name + " · " + when(last.decided_at), changes: "Asked for a change: " + (last.note || ""), withdrawn: "Approval taken back" }[last.state];
        var acts = "";
        if (d.can.producer && !closed && c.status === "ready") {
          if (last && last.state === "live") acts += '<button type="button" class="btn ghost small" data-cancel="' + h(last.id) + '">Cancel link</button>';
          else if (!last || last.state !== "approved") acts += '<button type="button" class="btn small" data-ask="' + h(c.id) + '" data-person="' + h(p.id) + '">' + (last ? "Send a new link" : "Send review link") + "</button>";
          if (last && last.state === "approved") acts += '<button type="button" class="btn danger small" data-withdraw="' + h(last.id) + '">They took it back</button>';
        }
        return '<div class="row" style="align-items:flex-start;padding:6px 0;border-top:1px solid #1E2C40"><div class="grow"><div class="name" style="font-size:14px">' + h(p.person_code) + ' <span class="sub">' + h(p.reviewer_relation === "self" ? "approves their own cut" : "parent or guardian approves") + '</span></div><div class="sub">' + h(stateText) + "</div></div>" + (acts ? '<div class="btn-row" style="flex:none">' + acts + "</div>" : "") + "</div>";
      }).join("");
      return '<article class="card"><div class="row"><div class="grow"><div class="name">' + h(cutLabel(c)) + '</div><div class="sub">' + h(c.file_name) + " · in it: " + h(inIt) + "</div>" +
        (c.warnings && c.warnings.length ? '<div class="sub warnc">' + h(c.warnings.join(" · ")) + "</div>" : "") + (c.error ? '<div class="sub err">' + h(c.error) + "</div>" : "") + "</div>" + st + "</div>" +
        (c.watch_url ? '<video controls playsinline preload="none" src="' + h(c.watch_url) + '"' + (c.poster_url ? ' poster="' + h(c.poster_url) + '"' : "") + ' style="width:100%;max-height:60vh;border-radius:12px;background:#000"></video>' : "") +
        (speakers.length ? rows : c.status === "ready" ? '<p class="sub warnc">No speaker is listed in this cut, so nobody can approve it.</p>' : "") + "</article>";
    }).join("");

    var postRows = posts.map(function (p) {
      var c = cuts.find(function (x) { return x.id === p.cut_id; });
      return '<div class="row" style="padding:8px 0;border-top:1px solid #1E2C40"><div class="grow"><div class="name" style="font-size:14.5px">' + h(p.platform) + " · " + h(cutLabel(c)) + '</div><div class="sub"><a href="' + h(p.url) + '" target="_blank" rel="noopener" style="color:var(--ink-2)">' + h(p.url) + "</a></div><div class=\"sub\">" + (p.removed_at ? "Taken down " + h(t.ago(p.removed_at)) : "Posted " + h(t.ago(p.posted_at)) + " by " + h(p.posted_by)) + "</div></div>" +
        (!p.removed_at && d.can.producer ? '<button type="button" class="btn ghost small" data-down="' + h(p.id) + '" style="flex:none">Mark taken down</button>' : "") + "</div>";
    }).join("");
    var finalDone = d.steps.some(function (s) { return s.step === "final_signoff" && s.status === "done"; });
    var postForm = d.can.owner && finalDone && !closed ? '<div class="field" style="margin-top:8px"><select class="input" id="postCut">' + approved.map(function (c) { return '<option value="' + h(c.id) + '">' + h(cutLabel(c)) + "</option>"; }).join("") + '</select><select class="input" id="postPlatform">' + meta.platforms.map(function (p) { return "<option>" + h(p) + "</option>"; }).join("") + '</select><input class="input" id="postUrl" type="url" inputmode="url" placeholder="https://… the post"><button type="button" class="btn small" id="recordPost"' + (approved.length ? "" : " disabled") + ">Record the post</button></div>" : "";

    var tds = (d.takedowns || []).map(function (x) {
      var l = left(x.due_at), open = x.items.filter(function (i) { return !i.done_at; }).length;
      return '<div class="row" style="padding:6px 0"><div class="grow"><div class="name" style="font-size:14.5px">Takedown · ' + h(x.person_code) + '</div><div class="sub">' + (x.closed_at ? "Closed " + h(t.ago(x.closed_at)) : open + " of " + x.items.length + " still up") + "</div></div>" + (x.closed_at ? badge("Done", "ok") : badge(l.text, l.late || l.tight ? "bad" : "warn")) + "</div>";
    }).join("");

    var stepLabel = {};
    d.steps.forEach(function (s) { stepLabel[s.step] = s.label; });
    var subjectWords = function (e) {
      var sj = e.subject || "";
      if (/^step_|^second_yes/.test(e.kind)) return stepLabel[sj] || sj;
      if (e.kind === "film_created") return "(" + fmtLabel(f.kit_slug, sj) + ")";
      var m = /^([a-z_]+) (\d+x\d+) v(\d+)$/.exec(sj);
      if (m) return fmtLabel(f.kit_slug, m[1]) + " " + ratio(m[2]) + " v" + m[3];
      return sj.replace(/_/g, " ");
    };
    var hist = (d.events || []).slice(0, 60).map(function (e) {
      var who = e.by_staff || e.by_reviewer || "";
      var subj = e.kind === "second_yes" ? "" : subjectWords(e);
      return '<div class="row" style="padding:7px 0;border-top:1px solid #1E2C40;align-items:flex-start"><div class="grow body" style="font-size:13.5px"><b style="color:var(--ink)">' + h(who) + "</b> " + h(EVENT[e.kind] || e.kind) + (subj ? " " + h(subj) : "") + (e.note ? ' <span class="sub">· ' + h(e.note) + "</span>" : "") + ' <span class="sub">· ' + h(t.ago(e.at)) + "</span></div></div>";
    }).join("");

    t.show("studio",
      '<div class="screen">' + back + head + pulledBox +
      '<section class="sec"><h2 class="sec-h">The ten steps</h2><ol class="steps">' + steps + "</ol></section>" +
      '<section class="sec"><h2 class="sec-h">Clearance cards · ' + people.length + '</h2><p class="sub" style="margin:0">No card, no shoot: everyone on camera has a cleared card first.</p>' + (cards || '<p class="empty">No cards yet.</p>') + (closed ? "" : '<a class="btn soft small" href="#film-person/' + h(f.id) + '/new">Add a card</a>') + "</section>" +
      '<section class="sec"><h2 class="sec-h">Cuts · ' + cuts.length + '</h2><p class="sub" style="margin:0">Each cut lists everyone in it: that\'s the clip log a takedown follows. Speakers (a minor\'s parent or guardian) approve their own cut on a one-time link.</p>' + (cutCards || '<p class="empty">No cuts yet.</p>') +
      (closed ? "" : reviewOn ? '<a class="btn soft small" href="#film-cut/' + h(f.id) + '">Upload a cut for review</a>' : '<p class="sub warnc">Review copies are off until Kyron approves storing them (Tool approvals).</p>') + "</section>" +
      '<section class="sec"><h2 class="sec-h">Where it went out</h2>' + (postRows || '<p class="empty">Nothing posted. Only Kyron posts, after the final sign-off, and only cuts their speakers approved.</p>') + postForm + "</section>" +
      (tds ? '<section class="sec"><h2 class="sec-h">Takedowns</h2>' + tds + "</section>" : "") +
      '<section class="sec"><h2 class="sec-h">History</h2><div class="field"><textarea class="textarea" id="noteText" maxlength="1000" style="min-height:70px" placeholder="Add a note to the history (no names of minors)"></textarea><button type="button" class="btn ghost small" id="addNote">Add note</button></div>' + hist + "</section>" +
      (d.can.producer && !f.pulled_at ? '<div class="btn-row"><button type="button" class="btn ghost small" id="archive">' + (f.archived_at ? "Bring it back" : "Archive this film") + "</button></div>" : "") +
      msgBox("roomMsg") + "</div>");

    var reload = function () { film(id); };
    var done = document.getElementById("stepDone");
    if (done) done.addEventListener("click", async function () {
      var body = { note: (document.getElementById("stepNote") || {}).value || "" };
      var sc = document.getElementById("stepCut");
      if (sc) body.cut_id = sc.value;
      done.disabled = true;
      try { await t.post("/api/studio-films/films/" + f.id + "/steps/" + done.dataset.step + "/done", body); t.toast("Done."); reload(); } catch (e) { done.disabled = false; say("roomMsg", why(e), true); done.scrollIntoView({ block: "center" }); }
    });
    var second = document.getElementById("recordSecond");
    if (second) second.addEventListener("click", async function () {
      try { await t.post("/api/studio-films/films/" + f.id + "/second-yes", { note: document.getElementById("secondYes").value }); reload(); } catch (e) { say("roomMsg", why(e), true); }
    });
    var reopen = document.getElementById("reopen");
    if (reopen) armed(reopen, "Tap again to reopen", async function () {
      await t.post("/api/studio-films/films/" + f.id + "/steps/" + reopen.dataset.step + "/reopen", { note: document.getElementById("reopenWhy").value });
      reload();
    });
    document.querySelectorAll("[data-clear]").forEach(function (b) {
      b.addEventListener("click", async function () { b.disabled = true; try { await t.post("/api/studio-films/films/" + f.id + "/people/" + b.dataset.clear + "/clear", { seen: b.dataset.seen }); t.toast("Cleared."); reload(); } catch (e) { b.disabled = false; T().toast(why(e)); } });
    });
    document.querySelectorAll("[data-pull]").forEach(function (b) {
      armed(b, "Tap again: it can't be undone", async function () {
        var note = document.querySelector('[data-pullnote="' + b.dataset.pull + '"]').value;
        var r = await t.post("/api/studio-films/people/pull", { person_code: b.dataset.pull, note: note, confirm: true });
        t.toast("Takedown started: " + (r.films || 0) + " film(s). 72 hours.");
        T().go("#film-takedowns");
      });
    });
    document.querySelectorAll("[data-ask]").forEach(function (b) {
      b.addEventListener("click", async function () { b.disabled = true; b.textContent = "Sending…"; try { await t.post("/api/studio-films/films/" + f.id + "/cuts/" + b.dataset.ask + "/reviews", { person_id: b.dataset.person }); t.toast("Review link sent."); reload(); } catch (e) { b.disabled = false; b.textContent = "Send review link"; T().toast(why(e)); } });
    });
    document.querySelectorAll("[data-cancel]").forEach(function (b) { armed(b, "Tap again to cancel", async function () { await t.post("/api/studio-films/reviews/" + b.dataset.cancel + "/cancel-link", {}); reload(); }); });
    document.querySelectorAll("[data-withdraw]").forEach(function (b) { armed(b, "Tap again: their yes is gone", async function () { await t.post("/api/studio-films/reviews/" + b.dataset.withdraw + "/withdraw", {}); reload(); }); });
    document.querySelectorAll("[data-down]").forEach(function (b) { armed(b, "Tap again: it's down", async function () { await t.post("/api/studio-films/posts/" + b.dataset.down + "/removed", {}); reload(); }); });
    var rp = document.getElementById("recordPost");
    if (rp) rp.addEventListener("click", async function () {
      rp.disabled = true;
      try { await t.post("/api/studio-films/films/" + f.id + "/posts", { cut_id: document.getElementById("postCut").value, platform: document.getElementById("postPlatform").value, url: document.getElementById("postUrl").value }); t.toast("Recorded."); reload(); } catch (e) { rp.disabled = false; say("roomMsg", why(e), true); }
    });
    document.getElementById("addNote").addEventListener("click", async function () {
      var v = document.getElementById("noteText").value.trim();
      if (!v) return;
      try { await t.post("/api/studio-films/films/" + f.id + "/notes", { note: v }); reload(); } catch (e) { say("roomMsg", why(e), true); }
    });
    var ar = document.getElementById("archive");
    if (ar) armed(ar, "Tap again", async function () { await t.post("/api/studio-films/films/" + f.id + "/archive", { archived: !f.archived_at }); T().go(f.archived_at ? "#film/" + f.id : "#films"); });
  }

  // ── Details and the board ────────────────────────────────────────────
  async function filmEdit(id) {
    if (!guard()) return;
    var t = T(), back = t.backBtn("#film/" + id, "Film");
    loading(back);
    var d;
    try { await getMeta(); d = await t.api("/api/studio-films/films/" + encodeURIComponent(id)); } catch (e) { if (e.stale) throw e; return failed(back, e); }
    var f = d.film, p = f.plan || {}, sp = p.speaker || {}, fp = p.frame_pair || {};
    var lines = function (arr, fn) { return (arr || []).map(fn).join("\n"); };
    var field = function (id2, label, value, opts) {
      opts = opts || {};
      return '<div class="field"><label class="label" for="' + id2 + '">' + label + "</label>" + (opts.area ? '<textarea class="textarea" id="' + id2 + '" style="min-height:' + (opts.h || 90) + 'px" maxlength="' + (opts.max || 2000) + '"' + (opts.ph ? ' placeholder="' + h(opts.ph) + '"' : "") + ">" + h(value || "") + "</textarea>" : '<input class="input" id="' + id2 + '" value="' + h(value || "") + '"' + (opts.type ? ' type="' + opts.type + '"' : "") + (opts.ph ? ' placeholder="' + h(opts.ph) + '"' : "") + ">") + "</div>";
    };
    t.show(null,
      '<div class="screen">' + back + '<h1 class="title sm">Details and board</h1><p class="lede">The board\'s parts the app keeps: Milanote stays the moodboard.</p>' +
      field("eTitle", "Working title <small>(never a name)</small>", f.title) +
      field("eStory", "One-sentence story", f.one_sentence, { area: true, h: 70, max: 300 }) +
      field("ePost", "Post date", f.post_date, { type: "date" }) +
      field("eBoard", "Milanote board link", f.board_url, { type: "url", ph: "https://app.milanote.com/…" }) +
      (d.can.producer ? field("eDir", "Director's email", f.director_email, { type: "email" }) + field("eEd", "Editor's email", f.editor_email, { type: "email" }) : "") +
      '<h2 class="sec-h" style="margin-top:8px">The shoot</h2>' +
      field("eShootDate", "Shoot date", p.shoot_date, { type: "date" }) +
      field("eLocations", "Locations <small>(one per line; no locker rooms, training rooms or changing areas)</small>", lines(p.locations, String), { area: true, h: 70 }) +
      field("eSchedule", "Call times <small>(one per line: 09:30 B-roll)</small>", lines(p.schedule, function (x) { return (x.time ? x.time + " " : "") + x.what; }), { area: true }) +
      field("eMust1", "Must-have shot 1", (p.must_have || [])[0]) + field("eMust2", "Must-have shot 2", (p.must_have || [])[1]) + field("eMust3", "Must-have shot 3", (p.must_have || [])[2]) +
      field("eOpen", "Opening frame", fp.opening) + field("eClose", "Closing frame (rhymes with the opening)", fp.closing) +
      '<h2 class="sec-h" style="margin-top:8px">The speaker</h2>' +
      field("sRole", "Their role in life", sp.role_in_life) + field("sWorld", "How the world sees them", sp.how_world_sees) + field("sHooks", "How Hooks sees them", sp.how_hooks_sees) + field("sWants", "What they want", sp.wants) + field("sStake", "What's at stake", sp.at_stake) +
      field("eQuotes", "Quotes, then questions <small>(one per line: the line you expect | the question that prompts it)</small>", lines(p.quotes, function (q) { return q.quote + " | " + q.question; }), { area: true, h: 140 }) +
      '<h2 class="sec-h" style="margin-top:8px">References</h2>' +
      field("eRefs", "From The feel <small>(one per line: https://… | what to take)</small>", lines(p.references, function (r) { return (r.url || "") + " | " + (r.note || ""); }), { area: true }) +
      field("eSong", "One song", p.song) +
      msgBox("editMsg") + "</div>" +
      '<div class="dock"><div class="dock-inner"><button type="button" class="btn block" id="saveFilm">Save</button></div></div>');
    var v = function (x) { var el = document.getElementById(x); return el ? el.value.trim() : ""; };
    var splitLines = function (x) { return v(x).split("\n").map(function (s) { return s.trim(); }).filter(Boolean); };
    document.getElementById("saveFilm").addEventListener("click", async function () {
      var btn = this;
      var plan = {
        shoot_date: v("eShootDate") || null,
        locations: splitLines("eLocations"),
        schedule: splitLines("eSchedule").map(function (l) { var m = /^(\d{1,2}:\d{2})\s+(.*)$/.exec(l); return m ? { time: m[1].padStart(5, "0"), what: m[2] } : { time: null, what: l }; }),
        must_have: [v("eMust1"), v("eMust2"), v("eMust3")].filter(Boolean),
        frame_pair: { opening: v("eOpen") || null, closing: v("eClose") || null },
        speaker: { role_in_life: v("sRole"), how_world_sees: v("sWorld"), how_hooks_sees: v("sHooks"), wants: v("sWants"), at_stake: v("sStake") },
        quotes: splitLines("eQuotes").map(function (l) { var i = l.indexOf("|"); return i >= 0 ? { quote: l.slice(0, i).trim(), question: l.slice(i + 1).trim() } : { quote: l, question: "" }; }),
        references: splitLines("eRefs").map(function (l) { var i = l.indexOf("|"); var u = (i >= 0 ? l.slice(0, i) : l).trim(); var n = i >= 0 ? l.slice(i + 1).trim() : ""; return /^https:\/\//.test(u) ? { url: u, note: n } : { url: null, note: l }; }),
        song: v("eSong") || null,
      };
      var body = { seen: f.updated_at, title: v("eTitle"), one_sentence: v("eStory") || null, post_date: v("ePost") || null, board_url: v("eBoard") || null, plan: plan };
      if (d.can.producer) { body.director_email = v("eDir") || null; body.editor_email = v("eEd") || null; }
      btn.disabled = true;
      try { await t.post("/api/studio-films/films/" + f.id, body, "PATCH"); t.toast("Saved."); T().go("#film/" + f.id); } catch (e) { btn.disabled = false; say("editMsg", why(e), true); }
    });
  }

  // ── A clearance card ─────────────────────────────────────────────────
  async function filmPerson(arg) {
    if (!guard()) return;
    var parts = String(arg || "").split("/"), id = parts[0], pid = parts[1];
    var t = T(), back = t.backBtn("#film/" + id, "Film");
    loading(back);
    var d;
    try { await getMeta(); d = await t.api("/api/studio-films/films/" + encodeURIComponent(id)); } catch (e) { if (e.stale) throw e; return failed(back, e); }
    var f = d.film, tp = tpl(f.kit_slug);
    var p = pid === "new" ? null : d.people.find(function (x) { return x.id === pid; });
    if (pid !== "new" && !p) return failed(back, { message: "That card isn't on this film." });
    var s = p ? JSON.parse(JSON.stringify(p)) : { person_code: "", name: "", role: "athlete", is_minor: false, texas_youth: false, speaker: false, release_on_file: false, covers: { face: false, name: false, jersey: false, voice: false, formats: [] }, reviewer_relation: null, reviewer_name: "", reviewer_email: "" };
    s.covers = s.covers || {};
    function sw(key, label, sub, on, disabled) { return '<label class="li" style="cursor:pointer;border-radius:14px;border:1px solid var(--line)"><div class="grow"><div class="name" style="font-size:15px">' + h(label) + "</div>" + (sub ? '<div class="sub">' + h(sub) + "</div>" : "") + '</div><input type="checkbox" class="switch" data-k="' + key + '"' + (on ? " checked" : "") + (disabled ? " disabled" : "") + "></label>"; }
    function draw() {
      var ty = s.texas_youth;
      var rel = s.is_minor || ty ? (s.reviewer_relation === "guardian" ? "guardian" : "parent") : "self";
      t.show(null,
        '<div class="screen">' + back + '<h1 class="title sm">' + (p ? "Clearance card" : "Add a card") + '</h1><p class="lede">Everyone on camera gets one. The name stays on this card; everything else carries the code.' + (p && p.cleared_at ? " Changing a cleared card clears it again." : "") + "</p>" +
        (p ? '<div class="field"><span class="label">Code</span><div class="name">' + h(p.person_code) + "</div></div>" : '<div class="field"><label class="label" for="pCode">Code <small>(the athlete ID; a parent adds -P1)</small></label><input class="input" id="pCode" maxlength="20" autocapitalize="characters" placeholder="' + h(f.athlete_id) + '" value="' + h(s.person_code) + '"></div>') +
        '<div class="field"><label class="label" for="pName">Name</label><input class="input" id="pName" maxlength="80" autocomplete="off" value="' + h(s.name) + '"></div>' +
        '<div class="field"><label class="label" for="pRole">Role</label><select class="input" id="pRole">' + ["athlete", "parent", "guardian", "coach", "other"].map(function (r) { return '<option value="' + r + '"' + (s.role === r ? " selected" : "") + ">" + r + "</option>"; }).join("") + "</select></div>" +
        '<div style="display:flex;flex-direction:column;gap:8px">' +
        sw("texas_youth", "Texas youth athlete", "Unidentifiable until counsel clears it: no face, name or jersey number", ty) +
        sw("is_minor", "Under 18", "A parent or legal guardian approves their cut", s.is_minor || ty, ty) +
        sw("speaker", "Speaker", "Their words are in the film: they (or a parent) approve the cut", s.speaker) +
        sw("release_on_file", "Release on file", "No release, no card", s.release_on_file) + "</div>" +
        '<div class="field"><span class="label">What the release covers</span><div style="display:flex;flex-direction:column;gap:8px">' +
        sw("c_face", "Face", ty ? "Never, for Texas youth" : "", !ty && s.covers.face, ty) + sw("c_name", "Name", "", !ty && s.covers.name, ty) + sw("c_jersey", "Jersey number", "", !ty && s.covers.jersey, ty) + sw("c_voice", "Voice", "", s.covers.voice) + "</div>" +
        '<div class="sub" style="margin-top:6px">Formats it covers</div><div style="display:flex;flex-wrap:wrap;gap:6px">' + Object.keys(tp.formats).map(function (k) { return '<label class="badge" style="cursor:pointer;min-height:34px"><input type="checkbox" data-fmt="' + k + '"' + ((s.covers.formats || []).indexOf(k) >= 0 ? " checked" : "") + "> " + h(tp.formats[k].label) + "</label>"; }).join("") + "</div></div>" +
        '<div class="field"><span class="label">Who approves the cut</span><div class="seg" role="group" aria-label="Who approves">' + (s.is_minor || ty ? '<button type="button" data-rel="parent" aria-pressed="' + (rel === "parent") + '">Parent</button><button type="button" data-rel="guardian" aria-pressed="' + (rel === "guardian") + '">Legal guardian</button>' : '<button type="button" aria-pressed="true">Themselves (18+)</button>') + "</div>" +
        '<input class="input" id="rName" maxlength="80" placeholder="' + (rel === "self" ? "Their name" : "Parent or guardian's name") + '" value="' + h(s.reviewer_name || "") + '"><input class="input" id="rEmail" type="email" placeholder="Their email (the review link goes here)" value="' + h(s.reviewer_email || "") + '"></div>' +
        msgBox("pMsg") + "</div>" +
        '<div class="dock"><div class="dock-inner"><button type="button" class="btn block" id="savePerson">' + (p ? "Save the card" : "Add the card") + '</button>' + (p && !p.cleared_at ? '<button type="button" class="btn danger small" id="delPerson">Remove this card</button>' : "") + "</div></div>");
      document.querySelectorAll("[data-k]").forEach(function (c) {
        c.addEventListener("change", function () {
          keep();
          var k = c.dataset.k;
          if (k.indexOf("c_") === 0) s.covers[k.slice(2)] = c.checked; else s[k] = c.checked;
          if (k === "texas_youth" && c.checked) { s.is_minor = true; s.covers.face = s.covers.name = s.covers.jersey = false; }
          draw();
        });
      });
      document.querySelectorAll("[data-fmt]").forEach(function (c) { c.addEventListener("change", function () { var a = s.covers.formats || []; var k = c.dataset.fmt; s.covers.formats = c.checked ? a.concat([k]) : a.filter(function (x) { return x !== k; }); }); });
      document.querySelectorAll("[data-rel]").forEach(function (b) { b.addEventListener("click", function () { keep(); s.reviewer_relation = b.dataset.rel; draw(); }); });
      document.getElementById("savePerson").addEventListener("click", save);
      var del = document.getElementById("delPerson");
      if (del) armed(del, "Tap again to remove", async function () { await t.post("/api/studio-films/films/" + id + "/people/" + p.id, {}, "DELETE"); T().go("#film/" + id); });
    }
    function keep() {
      var g = function (x) { var el = document.getElementById(x); return el ? el.value : null; };
      if (g("pCode") !== null) s.person_code = g("pCode");
      s.name = g("pName"); s.role = g("pRole"); s.reviewer_name = g("rName"); s.reviewer_email = g("rEmail");
    }
    async function save() {
      keep();
      var minor = s.is_minor || s.texas_youth;
      var hasReviewer = (s.reviewer_name || "").trim() || (s.reviewer_email || "").trim();
      var body = { name: s.name, role: s.role, is_minor: minor, texas_youth: s.texas_youth, speaker: s.speaker, release_on_file: s.release_on_file, covers: s.covers,
        reviewer_relation: hasReviewer ? (minor ? (s.reviewer_relation === "guardian" ? "guardian" : "parent") : "self") : null, reviewer_name: hasReviewer ? s.reviewer_name : null, reviewer_email: hasReviewer ? s.reviewer_email : null };
      var btn = document.getElementById("savePerson");
      btn.disabled = true;
      try {
        if (p) { body.seen = p.updated_at; var r = await t.post("/api/studio-films/films/" + id + "/people/" + p.id, body, "PATCH"); t.toast(r.uncleared ? "Saved. It needs clearing again." : "Saved."); }
        else { body.person_code = s.person_code; await t.post("/api/studio-films/films/" + id + "/people", body); t.toast("Card added."); }
        T().go("#film/" + id);
      } catch (e) { btn.disabled = false; say("pMsg", why(e), true); }
    }
    draw();
  }

  // ── Upload a cut ─────────────────────────────────────────────────────
  var busy = 0;
  window.addEventListener("beforeunload", function (e) { if (busy) { e.preventDefault(); e.returnValue = ""; } });
  function put(url, file, type, progress) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open("PUT", url);
      x.setRequestHeader("Content-Type", type);
      x.upload.onprogress = function (e) { if (e.lengthComputable) progress(e.loaded / e.total); };
      x.onload = function () { x.status >= 200 && x.status < 300 ? resolve() : reject(new Error("Storage refused it (" + x.status + ").")); };
      x.onerror = function () { reject(new Error("The upload stopped. Check the connection, then try again.")); };
      x.send(file);
    });
  }
  async function filmCut(id) {
    if (!guard()) return;
    var t = T(), back = t.backBtn("#film/" + id, "Film");
    loading(back);
    var d;
    try { await getMeta(); d = await t.api("/api/studio-films/films/" + encodeURIComponent(id)); } catch (e) { if (e.stale) throw e; return failed(back, e); }
    var f = d.film, tp = tpl(f.kit_slug);
    var s = { format: f.format, ratio: (tp.formats[f.format] || {}).ratios ? tp.formats[f.format].ratios[0] : "9x16", file: null, people: d.people.filter(function (p) { return p.cleared_at && !p.consent_pulled_at; }).map(function (p) { return p.id; }) };
    function nextVersion() { return d.cuts.filter(function (c) { return c.format === s.format && c.ratio === s.ratio; }).reduce(function (m, c) { return Math.max(m, c.version); }, 0) + 1; }
    function kitName() { var day = new Date().toISOString().slice(0, 10).replace(/-/g, ""); var fm = tp.formats[s.format]; return [tp.file_prefix || "SW", (tp.lanes[f.lane] || {}).code || "LANE", f.athlete_id, fm ? fm.code : "FMT", s.ratio, "v" + String(nextVersion()).padStart(2, "0"), day].join("_") + ".mp4"; }
    function draw() {
      var fm = tp.formats[s.format] || {};
      t.show(null,
        '<div class="screen">' + back + '<h1 class="title sm">Upload a cut</h1><p class="lede">The review copy speakers watch. Export it at 720p (up to ' + meta.max_review_mb + ' MB) with the sound. It goes straight to private storage; the app burns in REVIEW COPY.</p>' +
        '<div class="field"><label class="label" for="cFormat">Format</label><select class="input" id="cFormat">' + Object.keys(tp.formats).filter(function (k) { return !tp.formats[k].still && !tp.formats[k].slides; }).map(function (k) { return '<option value="' + k + '"' + (s.format === k ? " selected" : "") + ">" + h(tp.formats[k].label + " · " + tp.formats[k].spec) + "</option>"; }).join("") + "</select></div>" +
        '<div class="field"><span class="label">Ratio</span><div class="seg" role="group" aria-label="Ratio">' + (fm.ratios || ["9x16"]).map(function (r) { return '<button type="button" data-ratio="' + r + '" aria-pressed="' + (s.ratio === r) + '">' + ratio(r) + "</button>"; }).join("") + "</div></div>" +
        '<div class="field"><label class="label" for="cFile">The file</label><input class="input" id="cFile" type="file" accept="video/mp4,video/quicktime,.m4v"></div>' +
        '<div class="field"><label class="label" for="cName">File name <small>(the kit\'s way: athlete ID, never a name)</small></label><input class="input" id="cName" value="' + h(s.name || kitName()) + '"></div>' +
        '<div class="field"><span class="label">Who\'s in it <small>(the clip log)</small></span><div style="display:flex;flex-direction:column;gap:8px">' + d.people.map(function (p) {
          var off = !p.cleared_at || p.consent_pulled_at;
          return '<label class="li" style="cursor:pointer;border-radius:14px;border:1px solid var(--line)"><div class="grow"><div class="name" style="font-size:15px">' + h(p.person_code) + " · " + h(p.name) + '</div><div class="sub">' + h(p.consent_pulled_at ? "Consent pulled" : p.cleared_at ? (p.speaker ? "Speaker" : "On camera") : "Not cleared yet: clear the card first") + '</div></div><input type="checkbox" class="switch" data-pp="' + h(p.id) + '"' + (s.people.indexOf(p.id) >= 0 && !off ? " checked" : "") + (off ? " disabled" : "") + "></label>";
        }).join("") + "</div></div>" +
        msgBox("cMsg") + "</div>" +
        '<div class="dock"><div class="dock-inner"><button type="button" class="btn block" id="sendCut">Upload v' + nextVersion() + '</button><span class="note">The review copy takes a minute or two. Then send each speaker their link.</span></div></div>');
      document.getElementById("cFormat").addEventListener("change", function () { keep(); s.format = this.value; s.ratio = (tp.formats[s.format].ratios || ["9x16"])[0]; s.name = null; draw(); });
      document.querySelectorAll("[data-ratio]").forEach(function (b) { b.addEventListener("click", function () { keep(); s.ratio = b.dataset.ratio; s.name = null; draw(); }); });
      document.getElementById("cFile").addEventListener("change", function () { s.file = this.files && this.files[0] || null; });
      document.querySelectorAll("[data-pp]").forEach(function (c) { c.addEventListener("change", function () { var k = c.dataset.pp; s.people = c.checked ? s.people.concat([k]) : s.people.filter(function (x) { return x !== k; }); }); });
      document.getElementById("sendCut").addEventListener("click", send);
    }
    function keep() { s.name = document.getElementById("cName").value; }
    async function send() {
      keep();
      var btn = document.getElementById("sendCut");
      if (!s.file) return say("cMsg", "Pick the file first.", true);
      if (s.file.size > meta.max_review_mb * 1024 * 1024) return say("cMsg", "That file is over " + meta.max_review_mb + " MB. Export the review copy at 720p.", true);
      var v = nextVersion();
      var body = { format: s.format, ratio: s.ratio, version: v, file_name: s.name, bytes: s.file.size, people: s.people };
      btn.disabled = true; busy++;
      try {
        var up = await t.post("/api/studio-films/films/" + f.id + "/cuts/upload", body);
        await put(up.signed_url, s.file, up.content_type, function (pr) { btn.textContent = "Uploading " + Math.round(pr * 100) + "%"; });
        await t.post("/api/studio-films/films/" + f.id + "/cuts", Object.assign({}, body, { id: up.id, key: up.key }));
        t.toast("Uploaded. The review copy is on its way.");
        T().go("#film/" + f.id);
      } catch (e) { btn.disabled = false; btn.textContent = "Upload v" + v; say("cMsg", why(e), true); } finally { busy--; }
    }
    draw();
  }

  // ── Takedowns ────────────────────────────────────────────────────────
  async function filmTakedowns() {
    if (!guard()) return;
    var t = T(), back = t.backBtn("#films", "Films");
    loading(back);
    var d;
    try { d = await t.api("/api/studio-films/takedowns"); } catch (e) { if (e.stale) throw e; return failed(back, e); }
    var item = function (i) {
      var what = i.what === "post" && i.post ? i.post.platform + " · " + i.post.url : i.what === "elsewhere" ? "Everything outside the app: drives, the Milanote board, the editor's machine" : i.label;
      return '<div class="row" style="padding:8px 0;border-top:1px solid #1E2C40;align-items:flex-start"><div class="grow"><div class="name" style="font-size:14.5px">' + h(i.film ? i.film.title : "") + '</div><div class="sub" style="overflow-wrap:anywhere">' + h(what) + "</div>" + (i.done_at ? '<div class="sub" style="color:var(--ok)">Down · ' + h(i.done_by) + " · " + h(t.ago(i.done_at)) + (i.note ? " · " + h(i.note) : "") + "</div>" : "") + "</div>" +
        (i.done_at ? badge("Down", "ok") : '<div style="display:flex;flex-direction:column;gap:6px;flex:none;width:44%"><input class="input" data-itemnote="' + h(i.id) + '" placeholder="How (optional)" style="min-height:40px"><button type="button" class="btn small" data-item="' + h(i.id) + '">It\'s down</button></div>') + "</div>";
    };
    var card = function (x) {
      var l = left(x.due_at);
      var films = [];
      x.items.forEach(function (i) { if (i.film && !films.some(function (f) { return f.id === i.film.id; })) films.push(i.film); });
      return '<article class="card"><div class="row"><div class="grow"><div class="name">' + h(x.person_code) + '</div><div class="sub">' + h((x.source === "speaker" ? "Asked by the speaker" : "Recorded by " + x.requested_by) + " · " + when(x.requested_at)) + (x.note ? " · " + h(x.note) : "") + "</div></div>" + (x.closed_at ? badge("Closed", "ok") : badge(l.text, l.late || l.tight ? "bad" : "warn")) + "</div>" +
        x.items.map(item).join("") +
        (x.closed_at || !films.length ? "" : '<div class="field" style="margin-top:6px"><select class="input" data-addfilm="' + h(x.id) + '">' + films.map(function (f) { return '<option value="' + h(f.id) + '">' + h(f.title) + "</option>"; }).join("") + '</select><input class="input" data-addlabel="' + h(x.id) + '" maxlength="200" placeholder="Something else to take down (a repost, a shared drive)"><button type="button" class="btn ghost small" data-add="' + h(x.id) + '">Add it to the list</button></div>') + "</article>";
    };
    t.show("studio",
      '<div class="screen">' + back + '<div><p class="kicker">Studio · Films</p><h1 class="title">Takedowns</h1></div><p class="lede">When consent is pulled, every version comes down within 72 hours. The takedown closes when everything on it is down.</p>' +
      (d.open.length ? d.open.map(card).join("") : '<p class="empty">No open takedowns.</p>') +
      (d.recent.length ? '<section class="sec"><h2 class="sec-h">Closed in the last 30 days</h2>' + d.recent.map(card).join("") + "</section>" : "") + "</div>");
    document.querySelectorAll("[data-item]").forEach(function (b) {
      b.addEventListener("click", async function () { b.disabled = true; try { await t.post("/api/studio-films/takedown-items/" + b.dataset.item + "/done", { note: document.querySelector('[data-itemnote="' + b.dataset.item + '"]').value }); filmTakedowns(); } catch (e) { b.disabled = false; T().toast(why(e)); } });
    });
    document.querySelectorAll("[data-add]").forEach(function (b) {
      b.addEventListener("click", async function () { var k = b.dataset.add; try { await t.post("/api/studio-films/takedowns/" + k + "/items", { film_id: document.querySelector('[data-addfilm="' + k + '"]').value, label: document.querySelector('[data-addlabel="' + k + '"]').value }); filmTakedowns(); } catch (e) { T().toast(why(e)); } });
    });
  }

  // ── Tool approvals ───────────────────────────────────────────────────
  var TOOL_WORDS = {
    review_copies: "Review copies of cuts are stored in the app's private storage (Supabase), so speakers can watch them on their link. Check its terms (no training on stored files) before turning it on.",
    claude_transcripts: "Claude reads interview transcripts to mark the strongest lines (real words only). Check Anthropic's terms for your account before turning it on. Adults first.",
    graphics_system: "The proposed type system (Playfair Display, Oswald, Courier Prime, cream on dark) for quote cards, letter slides and end cards. Turn it on once you and Coach Hooks approve it.",
  };
  async function filmTools() {
    if (!guard()) return;
    var t = T(), back = t.backBtn("#films", "Films");
    loading(back);
    meta = null;
    try { await getMeta(); } catch (e) { if (e.stale) throw e; return failed(back, e); }
    t.show("studio",
      '<div class="screen">' + back + '<div><p class="kicker">Studio · Films</p><h1 class="title sm">Tool approvals</h1></div><p class="lede">The kit\'s rule: a tool touches footage only once the producer has checked its terms and added it, with a one-line reason. These start off.</p>' +
      meta.tools.map(function (x) {
        return '<article class="card"><div class="row"><div class="grow"><div class="name">' + h(x.label) + "</div></div>" + (x.is_on ? badge("On", "ok") : badge("Off")) + '</div><p class="body" style="font-size:13.5px">' + h(TOOL_WORDS[x.tool] || "") + "</p>" +
          (x.decided_at ? '<p class="sub" style="margin:0">' + (x.is_on ? "Turned on" : "Turned off") + " by " + h(x.decided_by) + " · " + h(when(x.decided_at)) + (x.note ? " · " + h(x.note) : "") + "</p>" : "") +
          (meta.can.owner ? (x.is_on ? '<button type="button" class="btn danger small" data-off="' + h(x.tool) + '">Turn it off</button>' : '<div class="field"><input class="input" data-why="' + h(x.tool) + '" maxlength="500" placeholder="What you checked (terms, training opt-out, screenshot saved)"><button type="button" class="btn small" data-on="' + h(x.tool) + '">Turn it on</button></div>') : "") + "</article>";
      }).join("") + msgBox("toolMsg") + "</div>");
    document.querySelectorAll("[data-on]").forEach(function (b) {
      b.addEventListener("click", async function () { var note = document.querySelector('[data-why="' + b.dataset.on + '"]').value.trim(); if (!note) return say("toolMsg", "Say what you checked first.", true); try { await t.post("/api/studio-films/tools/" + b.dataset.on, { on: true, note: note }); filmTools(); } catch (e) { say("toolMsg", why(e), true); } });
    });
    document.querySelectorAll("[data-off]").forEach(function (b) { armed(b, "Tap again to turn it off", async function () { await t.post("/api/studio-films/tools/" + b.dataset.off, { on: false }); filmTools(); }); });
  }

  // ── Today ────────────────────────────────────────────────────────────
  async function todayParts() {
    var t = T();
    await getMeta();
    var d = await t.api("/api/studio-films/today");
    var needs = (d.needs || []).map(function (n) {
      if (n.kind === "takedown") { var l = left(n.due_at); return '<a class="card tight" href="#film-takedowns" style="text-decoration:none;color:inherit"><div class="row"><div class="grow"><div class="name" style="font-size:15px">Takedown · ' + h(n.person_code) + '</div><div class="sub">Consent pulled: every version down within 72 hours</div></div>' + badge(l.text, "bad") + "</div></a>"; }
      if (n.kind === "changes") return '<a class="card tight" href="#film/' + h(n.film.id) + '" style="text-decoration:none;color:inherit"><div class="row"><div class="grow"><div class="name" style="font-size:15px">' + h(n.film.title) + '</div><div class="sub">A speaker asked for a change: ' + h(n.note || "") + "</div></div>" + badge("Change asked", "warn") + "</div></a>";
      if (n.kind === "cut_failed") return '<a class="card tight" href="#film/' + h(n.film.id) + '" style="text-decoration:none;color:inherit"><div class="row"><div class="grow"><div class="name" style="font-size:15px">' + h(n.film.title) + '</div><div class="sub">' + h(n.cut.label + ": " + (n.cut.error || "the review copy failed")) + "</div></div>" + badge("Failed", "bad") + "</div></a>";
      return '<a class="card tight" href="#film/' + h(n.film.id) + '" style="text-decoration:none;color:inherit"><div class="row"><div class="grow"><div class="name" style="font-size:15px">' + h(n.film.title) + '</div><div class="sub">' + h(fmtLabel("same-work", n.film.format) + " · " + n.film.athlete_id) + "</div></div>" + badge(n.label, "gold") + "</div></a>";
    }).join("");
    return { needs: needs, count: (d.needs || []).length };
  }

  window.TOJFilms = { todayParts: todayParts };
  window.TOJScreens = Object.assign(window.TOJScreens || {}, {
    films: films, "film-new": filmNew, film: film, "film-edit": filmEdit, "film-person": filmPerson, "film-cut": filmCut, "film-takedowns": filmTakedowns, "film-tools": filmTools,
  });
})();
