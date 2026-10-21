/* The Operating System builder in the TOJ app. A client's operating system
 * walks the trail in the order of the site and its launch video:
 *
 *   1 Raw operation      pick the door
 *   2 Foundation Score   the intake (from the site, or entered here)
 *   3 The Standard       five pillars: Claude drafts, an approver approves
 *   4 Transcript         the Operational Transcript: drafted, approved, into the portal
 *   5 Systemized         Intake, Delivery, Follow-up installed; the operating brain
 *   6 Trail of Joy       every system live, handed off
 *
 * Screens for app.js's router:
 *   #os                  the list
 *   #osnew               new: pick the door, then a site intake or start fresh
 *   #osb/<id>            one build, step by step
 *   #osintake/<id>       answer the intake in the app
 *   #osscores/<id>       edit the five-pillar scores
 *   #ostx/<id>           edit the transcript
 *   #osbrain/<id>        read the operating brain
 */
(function () {
  "use strict";
  var T = function () { return window.TOJ; };
  var h = function (s) { return T().h(s); };
  var $ = function (id) { return document.getElementById(id); };

  var MSG = {
    pick_a_door: "Pick a door first.",
    name_required: "Add the business name.",
    invalid_email: "That email doesn't look right.",
    authority_owner_only: "Authority builds can hold minors' data, so they stay with Kyron.",
    already_built: "That intake already has an operating system.",
    intake_first: "Add the intake answers first.",
    intake_locked_after_scoring: "The intake is locked once the scores are approved.",
    ai_not_configured: "Claude isn't connected on the server yet (ANTHROPIC_API_KEY). Score by hand for now.",
    already_drafting: "A draft is already on its way.",
    approve_scores_first: "Approve the five-pillar scores first.",
    fix_blockers_first: "Fix what's flagged before approving.",
    transcript_already_approved: "The transcript is already approved. New scores send it back to draft.",
    scores_locked: "Scores are locked once the install starts.",
    transcript_locked: "The transcript is locked once the install starts.",
    approve_transcript_first: "Approve the transcript first.",
    install_first: "Start the install first.",
    install_not_started: "Start the install first.",
    systems_not_live: "Every system has to be live first.",
    brain_first: "Generate the operating brain first.",
    already_running: "It's already running.",
    already_in_portal: "The transcript is already in that client's portal.",
    no_draft: "There's no draft yet.",
    role_too_low: "Your role can't do that.",
    not_on_team: "You don't have the Operating Systems tool. Ask Kyron.",
  };
  function say(e) {
    var c = e && e.data && e.data.error;
    return (c && MSG[c]) || (e && e.data && e.data.hint) || (e && e.message) || "Something went wrong.";
  }
  function badge(text, kind) { return '<span class="badge' + (kind ? " " + kind : "") + '">' + h(text) + "</span>"; }
  function dot(color) { return '<span style="display:inline-block;width:10px;height:10px;border-radius:5px;background:' + h(color) + ';flex:none"></span>'; }
  function when(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  }
  function dueBadge(iso) {
    if (!iso) return "";
    var late = new Date(iso).getTime() < Date.now();
    return badge((late ? "Transcript overdue · " : "Transcript due ") + when(iso), late ? "bad" : "warn");
  }
  function bandOf(s) { s = Number(s) || 0; return s >= 90 ? ["Advantage", "ok"] : s >= 70 ? ["Solid", "ok"] : s >= 40 ? ["Underperforming", "warn"] : ["Broken or missing", "bad"]; }
  function act(id, fn) {
    var el = $(id);
    if (!el) return;
    el.addEventListener("click", async function () {
      el.disabled = true;
      try { await fn(el); } catch (e) { if (!e.stale) T().toast(say(e)); } finally { el.disabled = false; }
    });
  }
  var PILLARS = ["brand_identity", "operational_health", "revenue_architecture", "content_credibility", "growth_readiness"];
  var PNAME = { brand_identity: "Brand Identity", operational_health: "Operational Health", revenue_architecture: "Revenue Architecture", content_credibility: "Content & Credibility", growth_readiness: "Growth Readiness" };
  function pname(v, k) { return v === "nonprofit" && k === "revenue_architecture" ? "Funding Architecture" : v === "authority" && k === "brand_identity" ? "Athlete Brand Identity" : PNAME[k]; }

  // ── The list ───────────────────────────────────────────────────────────
  async function os() {
    var t = T();
    if (!t.hasTool("os")) return t.go("#tools");
    t.show("tools", '<div class="screen"><h1 class="title">Operating Systems</h1><div class="spin"></div></div>');
    var d = await t.api("/api/os");
    var rows = (d.builds || []).map(function (b) {
      var st = d.stages[b.stage_n - 1] || {};
      return '<a class="li" href="#osb/' + h(b.id) + '"><div class="grow"><div class="name" style="font-size:15.5px;display:flex;gap:8px;align-items:center">' + dot((d.verticals[b.vertical] || {}).color || "#888") + h(b.name) + '</div><div class="sub">' + h(b.stage_n + " · " + st.name + (b.stage === "systemized" ? " · " + b.systems_progress.live + "/" + b.systems_progress.total + " live" : "")) + "</div></div>" +
        (b.waiting === "scores" ? badge("Scores to approve", "gold") : b.waiting === "transcript" ? badge("Transcript to approve", "gold") : b.transcript_due ? dueBadge(b.transcript_due) : b.stage === "running" ? badge("Running", "ok") : "") + t.I.chev + "</a>";
    }).join("");
    t.show("tools",
      '<div class="screen">' + t.backBtn("#tools", "Tools") +
      '<div class="head"><div><h1 class="title">Operating Systems</h1><p class="lede">Every client on the trail: door, Foundation Score, five pillars, transcript, systems, running.</p></div>' + (t.atLeast("member") ? '<a class="btn small" href="#osnew">' + t.I.plus.replace("<svg", '<svg width="16" height="16"') + "New</a>" : "") + "</div>" +
      (d.ai ? "" : '<div class="card tight"><div class="row"><span class="badge warn">Claude not connected</span><span class="sub grow">Scores and transcripts are written by hand until ANTHROPIC_API_KEY is set on the server.</span></div></div>') +
      (rows ? '<div class="list">' + rows + "</div>" : '<p class="empty">No operating systems yet.' + (t.atLeast("member") ? " Start the first one." : "") + "</p>") +
      "</div>");
  }

  // ── New: the door, then a site intake or start fresh ───────────────────
  async function osnew() {
    var t = T();
    if (!t.atLeast("member") || !t.hasTool("os")) return t.go("#os");
    t.show(null, '<div class="screen"><div class="head"><a class="back" href="#os">' + t.I.back + 'Cancel</a></div><div class="spin"></div></div>');
    var res = await Promise.all([t.api("/api/os"), t.api("/api/os/intakes")]);
    var V = res[0].verticals, intakes = res[1].intakes || [];
    var door = null;
    function draw() {
      var doors = Object.keys(V).filter(function (k) { return k !== "authority" || t.isOwner(); }).map(function (k) {
        var on = door === k;
        return '<button type="button" role="radio" class="radio" data-door="' + k + '" aria-checked="' + on + '" style="border-top:5px solid ' + h(V[k].color) + '"><span class="r"></span><span><b style="display:block;font-size:16px">' + h(V[k].label) + '</b><span class="sub">' + h(V[k].for) + "</span></span></button>";
      }).join("");
      var mine = intakes.filter(function (i) { return i.vertical === door; });
      t.show(null,
        '<div class="screen"><div class="head"><a class="back" href="#os">' + t.I.back + 'Cancel</a></div><h1 class="title sm">New operating system</h1>' +
        '<p class="lede">Step 1 of the trail: which door does this business come through?</p>' +
        '<div role="radiogroup" aria-label="Door" style="display:flex;flex-direction:column;gap:8px">' + doors + "</div>" +
        (t.isOwner() ? "" : '<p class="sub" style="margin:0">Authority builds can hold minors\' data, so they stay with Kyron.</p>') +
        (door ? (mine.length ? '<section class="sec"><h2 class="sec-h">From the site\'s Foundation Score</h2><div class="list">' + mine.map(function (i) {
          return '<button type="button" class="li" data-fs="' + h(i.id) + '"><div class="grow"><div class="name" style="font-size:15px">' + h(i.name) + '</div><div class="sub">Submitted ' + h(when(i.submitted_at)) + (i.has_transcript ? " · already has a transcript link" : "") + "</div></div>" + t.I.chev + "</button>";
        }).join("") + "</div></section>" : "") +
          '<section class="sec"><h2 class="sec-h">' + (mine.length ? "Or start fresh" : "Start fresh") + '</h2>' +
          '<div class="field"><label class="label" for="nm">Business name</label><input class="input" id="nm" type="text" maxlength="120" autocomplete="off"></div>' +
          '<div class="field"><label class="label" for="em">Client\'s email <small>(their portal gets the transcript)</small></label><input class="input" id="em" type="email" inputmode="email" autocomplete="off"></div>' +
          '<button type="button" class="btn block" id="go">Start on the trail</button><p id="msg" class="body" role="status"></p></section>' : "") +
        "</div>");
      document.querySelectorAll("[data-door]").forEach(function (b) { b.addEventListener("click", function () { door = b.dataset.door; draw(); }); });
      document.querySelectorAll("[data-fs]").forEach(function (b) {
        b.addEventListener("click", async function () {
          b.disabled = true;
          try { var d = await t.post("/api/os", { foundation_score_id: b.dataset.fs }); t.toast("Intake brought in."); t.go("#osb/" + d.build.id); }
          catch (e) { b.disabled = false; t.toast(say(e)); }
        });
      });
      act("go", async function () {
        var nm = $("nm").value.trim(), em = $("em").value.trim();
        if (!nm) { $("msg").innerHTML = '<span class="err">Add the business name.</span>'; return; }
        try { var d = await t.post("/api/os", { vertical: door, name: nm, contact_email: em, intake: { business_name: nm } }); t.go("#osintake/" + d.build.id); }
        catch (e) { $("msg").innerHTML = '<span class="err">' + h(say(e)) + "</span>"; }
      });
    }
    draw();
  }

  // ── One build ──────────────────────────────────────────────────────────
  // The step being worked on: the stage reached is done; the next one is "now".
  // Systemized stays "now" until it's handed off.
  function workStep(stage, n) { return stage === "running" ? 7 : stage === "systemized" ? 5 : n + 1; }
  function trail(stages, cur) {
    var s = stages[Math.min(cur, 6) - 1];
    return '<div class="card tight" style="gap:10px"><div style="display:flex;align-items:center;gap:4px">' + stages.map(function (x) {
      var done = x.n < cur, now = x.n === cur;
      return '<span title="' + h(x.name) + '" style="flex:1;height:8px;border-radius:4px;background:' + (done ? "var(--gold)" : now ? "linear-gradient(90deg,var(--gold) 50%,var(--chip) 50%)" : "var(--chip)") + '"></span>';
    }).join("") + "</div>" + (cur > 6 ? '<div class="row"><span class="badge ok">Running</span><span class="name grow" style="font-size:15px">On the Trail of Joy</span></div><div class="sub" style="margin-top:-4px">All six steps done</div>' :
      '<div class="row"><span class="badge gold">Step ' + cur + ' of 6</span><span class="name grow" style="font-size:15px">' + h(s.name) + '</span></div><div class="sub" style="margin-top:-4px">' + h(s.what) + "</div>") + "</div>";
  }
  function step(n, cur, title, inner) {
    var state = n < cur ? "done" : n === cur ? "now" : "later";
    return '<section class="card" style="' + (state === "now" ? "border-color:var(--gold)" : state === "later" ? "opacity:.6" : "") + '"><div class="row"><span class="badge' + (state === "done" ? " ok" : state === "now" ? " gold" : "") + '" style="min-width:28px;justify-content:center">' + (state === "done" ? "✓" : n) + '</span><h2 class="name grow" style="margin:0;font-size:16px">' + h(title) + "</h2></div>" + inner + "</section>";
  }
  function scoreRows(v, pillars) {
    return '<div class="list">' + PILLARS.map(function (k) {
      var p = pillars[k] || {}, b = bandOf(p.score);
      return '<div class="li" style="cursor:default;align-items:flex-start"><div class="grow"><div class="name" style="font-size:15px">' + h(pname(v, k)) + '</div><div class="sub">' + h(p.evidence || "") + (p.gap ? '</div><div class="sub" style="color:var(--faint)">Gap: ' + h(p.gap) : "") + '</div></div><div style="text-align:right"><div class="name" style="font-size:20px">' + h(p.score) + '</div><span class="badge ' + b[1] + '">' + h(b[0]) + "</span></div></div>";
    }).join("") + "</div>";
  }

  async function osb(id) {
    var t = T();
    if (!t.hasTool("os")) return t.go("#tools");
    t.show(null, '<div class="screen">' + t.backBtn("#os", "Operating Systems") + '<div class="spin"></div></div>');
    var d = await t.api("/api/os/" + encodeURIComponent(id));
    var b = d.build, n = b.stage_n, cur = b.stage === "systemized" && b.systems_progress.all_live && b.brain ? 6 : workStep(b.stage, n), mem = t.atLeast("member"), appr = t.atLeast("approver"), v = b.vertical;
    var sc = b.score, tx = b.transcript;

    // 1 · the door
    var s1 = '<div class="row">' + dot(b.lane.color) + '<span class="body grow"><b style="color:var(--ink)">' + h(b.lane.label) + "</b> · " + h(b.lane.for) + "</span></div>";

    // 2 · Foundation Score intake
    var s2 = (b.intake.length ? '<details><summary class="sub" style="cursor:pointer">' + h(b.intake.length + " answers · " + (b.intake_source === "foundation_score" ? "from the site's Foundation Score" : "entered in the app")) + '</summary><div class="list" style="margin-top:8px">' + b.intake.map(function (r) {
      return '<div class="li" style="cursor:default;align-items:flex-start;min-height:0"><div class="grow"><div class="sub">' + h(r.label) + '</div><div class="body">' + h(r.value) + "</div></div></div>";
    }).join("") + "</div></details>" : '<p class="empty">No answers yet.</p>') +
      (b.transcript_due && n <= 3 ? '<div class="row">' + dueBadge(b.transcript_due) + '<span class="sub">The site promises the written report inside 72 business hours.</span></div>' : "") +
      (mem && n <= 2 ? '<a class="btn small soft" href="#osintake/' + h(b.id) + '">' + (b.intake.length ? "Add or change answers" : "Answer the intake") + "</a>" : "");

    // 3 · The Standard: five pillars
    var s3 = "";
    if (n < 2) s3 = '<p class="empty">After the intake.</p>';
    else if (sc.approved) {
      s3 = '<div class="row"><span class="sub grow">Approved by ' + h(sc.approved_by) + " · " + h(when(sc.approved_at)) + '</span><span class="name">' + h(sc.total) + "/500</span></div>" + scoreRows(v, sc.approved) +
        (sc.weakest ? '<p class="body" style="margin:0">Fix first: <b style="color:var(--ink)">' + h(pname(v, sc.weakest)) + "</b></p>" : "");
      if (sc.draft && sc.status === "ready" && sc.draft.drafted_at > sc.approved_at && n < 5) s3 += '<div class="card tight"><div class="row"><span class="badge gold">New draft</span><span class="sub grow">A newer draft is waiting.</span></div>' + scoreRows(v, sc.draft.pillars) + (appr ? '<button type="button" class="btn small" id="scApprove">Approve the new scores</button>' : "") + "</div>";
    } else if (sc.status === "running") {
      s3 = '<div class="row"><div class="spin"></div><span class="body grow">Claude is scoring the intake against the five pillars. Usually under a minute.</span></div>';
      t.later(function () { if (location.hash === "#osb/" + id) osb(id); }, 3500);
    } else if (sc.draft) {
      var issues = (sc.draft.issues || []).filter(function (i) { return i.issue === "capped_without_evidence"; });
      s3 = '<div class="row"><span class="badge gold">Draft</span><span class="sub grow">' + h(sc.draft.source === "manual" ? "Scored by hand" : "Drafted by Claude" + (sc.draft.source === "agent+edited" ? ", edited" : "")) + "</span></div>" +
        (sc.draft.summary ? '<p class="body" style="margin:0">' + h(sc.draft.summary) + "</p>" : "") + scoreRows(v, sc.draft.pillars) +
        (issues.length ? '<p class="sub" style="margin:0">Capped at 40 for lack of evidence: ' + h(issues.map(function (i) { return pname(v, i.pillar) + " (was " + i.from + ")"; }).join(", ")) + "</p>" : "") +
        '<div class="btn-row">' + (mem ? '<a class="btn small soft" href="#osscores/' + h(b.id) + '">Edit</a>' : "") + (appr ? '<button type="button" class="btn small" id="scApprove">Approve the scores</button>' : "") + "</div>" +
        (appr ? "" : '<p class="sub" style="margin:0">An approver or Kyron approves the scores.</p>');
    } else {
      s3 = (sc.status === "failed" ? '<p class="err" style="margin:0">The last draft didn\'t finish (' + h(sc.error || "error") + "). Try again or score by hand.</p>" : '<p class="body" style="margin:0">Each pillar gets a 0–100 score, one line of evidence from their answers, and the gap to close. Nothing scores above 40 without evidence.</p>') +
        (mem ? '<div class="btn-row">' + (b.ai ? '<button type="button" class="btn small" id="scDraft">Draft with Claude</button>' : "") + '<a class="btn small soft" href="#osscores/' + h(b.id) + '">Score by hand</a></div>' : "");
    }

    // 4 · the Operational Transcript
    var s4 = "";
    if (!sc.approved) s4 = '<p class="empty">After the scores are approved.</p>';
    else if (tx.approved) {
      s4 = '<div class="row"><span class="badge ok">Approved</span><span class="sub grow">' + h(tx.approved_by + " · " + when(tx.approved_at)) + "</span></div>" +
        (tx.published_at ? '<p class="body" style="margin:0">It\'s in the client\'s portal.</p>' : '<p class="body" style="margin:0">Kept internal: no client email on this build.' + (mem ? " Add one and it goes to their portal the next time a transcript is approved." : "") + "</p>") +
        '<a class="btn small soft" href="#tool/ostx:' + h(b.id) + ':approved">Open the transcript</a>';
    } else if (tx.status === "running") {
      s4 = '<div class="row"><div class="spin"></div><span class="body grow">Claude is writing the transcript from the approved scores.</span></div>';
      t.later(function () { if (location.hash === "#osb/" + id) osb(id); }, 3500);
    } else if (tx.draft) {
      var bl = tx.blockers || [];
      s4 = '<div class="row"><span class="badge gold">Draft</span><span class="sub grow">' + h(tx.sections.join(" · ")) + "</span></div>" +
        (bl.length ? '<p class="err" style="margin:0">' + h(bl.map(function (x) { return x === "banned_words" ? "Banned words: " + (tx.draft.banned || []).join(", ") : x.replace(/_/g, " "); }).join(" · ")) + "</p>" : "") +
        '<div class="btn-row"><a class="btn small soft" href="#tool/ostx:' + h(b.id) + ':draft">Preview</a>' + (mem ? '<a class="btn small soft" href="#ostx/' + h(b.id) + '">Edit</a>' : "") + "</div>" +
        (appr ? '<button type="button" class="btn block" id="txApprove"' + (bl.length ? " disabled" : "") + ">" + (b.contact_email ? "Approve and send to the client's portal" : "Approve (internal: no client email)") + "</button>" : '<p class="sub" style="margin:0">An approver or Kyron approves the transcript.</p>');
    } else {
      s4 = (tx.status === "failed" ? '<p class="err" style="margin:0">The last draft didn\'t finish (' + h(tx.error || "error") + ").</p>" : '<p class="body" style="margin:0">Seven sections: ' + h(tx.sections.join(" · ")) + ".</p>") +
        (mem ? '<div class="btn-row">' + (b.ai ? '<button type="button" class="btn small" id="txDraft">Draft with Claude</button>' : "") + '<a class="btn small soft" href="#ostx/' + h(b.id) + '">Write by hand</a></div>' : "");
    }

    // 5 · Systemized
    var s5 = "";
    if (n < 4) s5 = '<p class="empty">After the transcript is approved.</p>';
    else if (n === 4) s5 = '<p class="body" style="margin:0">We install the intake, delivery, and follow-up systems the business runs on.</p>' + (mem ? '<button type="button" class="btn small" id="install">Start the install</button>' : "");
    else {
      var groups = d.groups.map(function (g) {
        var items = b.systems.filter(function (s) { return s.group === g.key; });
        return '<div class="sec"><h3 class="sec-h">' + h(g.name) + '</h3><div class="list">' + items.map(function (s) {
          return '<div class="li" style="cursor:default"><div class="grow"><div class="name" style="font-size:14.5px">' + h(s.label) + '</div><div class="sub">Owner: ' + h(s.owner) + "</div></div>" +
            (mem && n === 5 ? '<select class="input" data-sys="' + h(s.id) + '" style="width:auto;min-height:36px;padding:2px 8px;font-size:14px" aria-label="Status">' + ["todo", "building", "live"].map(function (o) { return "<option" + (o === s.status ? " selected" : "") + ' value="' + o + '">' + (o === "todo" ? "To do" : o === "building" ? "Building" : "Live") + "</option>"; }).join("") + "</select>" : badge(s.status === "live" ? "Live" : s.status === "building" ? "Building" : "To do", s.status === "live" ? "ok" : s.status === "building" ? "warn" : "")) + "</div>";
        }).join("") + (mem && n === 5 ? '<div class="li" style="cursor:default"><input class="input grow" data-add="' + g.key + '" placeholder="Add a ' + h(g.name.toLowerCase()) + ' system" maxlength="120" style="min-height:40px"></div>' : "") + "</div></div>";
      }).join("");
      var p = b.systems_progress;
      s5 = '<div class="row"><span class="name grow" style="font-size:15px">' + p.live + " of " + p.total + ' live</span>' + (p.all_live ? badge("All live", "ok") : "") + "</div>" + groups +
        '<div class="card tight"><div class="row"><div class="grow"><div class="name" style="font-size:15px">The operating brain</div><div class="sub">' + (b.brain ? h(b.brain.files.length + " files · " + when(b.brain.generated_at)) : "CLAUDE.md, a daily workflow, a skill per system, the voice, the transcript") + "</div></div></div>" +
        '<div class="btn-row">' + (mem && n === 5 ? '<button type="button" class="btn small' + (b.brain ? " soft" : "") + '" id="brain">' + (b.brain ? "Regenerate" : "Generate") + "</button>" : "") + (b.brain ? '<a class="btn small soft" href="#osbrain/' + h(b.id) + '">Read it</a>' + (mem ? '<a class="btn small soft" href="/api/os/' + h(b.id) + '/brain.zip" download>Download .zip</a>' : "") : "") + "</div></div>";
    }

    // 6 · Trail of Joy
    var s6 = n === 6 ? '<p class="body" style="margin:0">Running since ' + h(when(b.running_at)) + ". Every system is live and the operating brain is handed off.</p>" :
      n === 5 ? '<p class="body" style="margin:0">When every system is live and the brain is generated, an approver hands it off.</p>' + (appr ? '<button type="button" class="btn block" id="running"' + (b.systems_progress.all_live && b.brain ? "" : " disabled") + ">Hand it off: it's running</button>" : "") :
      '<p class="empty">The last step.</p>';

    t.show(null,
      '<div class="screen">' + t.backBtn("#os", "Operating Systems") +
      '<div><p class="kicker">' + h(b.lane.label) + '</p><h1 class="title sm">' + h(b.name) + "</h1>" + (b.contact_email ? '<p class="sub" style="margin:4px 0 0">' + h(b.contact_email) + (b.linked_to_portal ? " · portal linked" : "") + "</p>" : "") + "</div>" +
      trail(d.stages, cur) +
      step(1, cur, "Raw operation · the door", s1) +
      step(2, cur, "Foundation Score · the intake", s2) +
      step(3, cur, "The Standard · five pillars", s3) +
      step(4, cur, "Operational Transcript", s4) +
      step(5, cur, "Systemized · Intake, Delivery, Follow-up", s5) +
      step(6, cur, "Trail of Joy · running", s6) +
      "</div>");

    var base = "/api/os/" + encodeURIComponent(b.id);
    act("scDraft", async function () { await t.post(base + "/scores/draft"); t.toast("Claude is scoring it."); osb(id); });
    act("scApprove", async function () {
      try { await t.post(base + "/scores/approve"); }
      catch (e) {
        if (e.data && e.data.error === "transcript_already_approved" && confirm("Approving new scores sends the transcript back to draft. Go ahead?")) await t.post(base + "/scores/approve", { confirm: true });
        else throw e;
      }
      t.toast("Scores approved."); osb(id);
    });
    act("txDraft", async function () { await t.post(base + "/transcript/draft"); t.toast("Claude is writing the transcript."); osb(id); });
    act("txApprove", async function () { var r = await t.post(base + "/transcript/approve"); t.toast(r.published ? "Approved. It's in the client's portal." : "Approved and kept internal."); osb(id); });
    act("install", async function () { await t.post(base + "/install"); t.toast("Install started."); osb(id); });
    act("brain", async function () { await t.post(base + "/brain"); t.toast("Operating brain generated."); osb(id); });
    act("running", async function () { await t.post(base + "/running"); t.toast("It's running on the Trail of Joy."); osb(id); });
    document.querySelectorAll("[data-sys]").forEach(function (sel) {
      sel.addEventListener("change", async function () {
        try { await t.post(base, { systems: [{ id: sel.dataset.sys, status: sel.value }] }, "PATCH"); osb(id); } catch (e) { t.toast(say(e)); }
      });
    });
    document.querySelectorAll("[data-add]").forEach(function (inp) {
      inp.addEventListener("keydown", async function (ev) {
        if (ev.key !== "Enter" || !inp.value.trim()) return;
        try { await t.post(base, { systems: [{ add: true, group: inp.dataset.add, label: inp.value.trim() }] }, "PATCH"); osb(id); } catch (e) { t.toast(say(e)); }
      });
    });
  }

  // ── The intake, in the app ─────────────────────────────────────────────
  async function osintake(id) {
    var t = T();
    if (!t.atLeast("member")) return t.go("#osb/" + id);
    var d = await t.api("/api/os/" + encodeURIComponent(id));
    var b = d.build, raw = b.intake_raw || {}, keys = d.app_intake || [];
    var extra = Object.keys(raw).filter(function (k) { return keys.indexOf(k) < 0 && k !== "contact_email" && k !== "contact_phone"; });
    var fields = keys.concat(extra).map(function (k) {
      var long = /goal|vision|blockers|notes|mission|voice|what_you_do|playing_bg|methodology|known_for/.test(k);
      var lab = (d.labels && d.labels[k]) || k.replace(/_/g, " ");
      return '<div class="field"><label class="label" for="f_' + h(k) + '">' + h(lab) + "</label>" + (long ? '<textarea class="textarea" id="f_' + h(k) + '" data-k="' + h(k) + '" style="min-height:90px">' + h(raw[k] || "") + "</textarea>" : '<input class="input" id="f_' + h(k) + '" data-k="' + h(k) + '" type="text" value="' + h(raw[k] || "") + '">') + "</div>";
    }).join("");
    t.show(null,
      '<div class="screen"><div class="head"><a class="back" href="#osb/' + h(id) + '">' + t.I.back + 'Back</a></div><h1 class="title sm">Foundation Score intake</h1>' +
      '<p class="lede">The short version of the site\'s intake for ' + h(b.lane.label) + ". Three answers or more moves it to step 2; Claude scores only what's written here.</p>" + fields +
      '<p id="msg" class="body" role="status"></p></div>' +
      '<div class="dock"><div class="dock-inner"><button type="button" class="btn block" id="save">Save the answers</button></div></div>');
    act("save", async function () {
      var intake = {};
      document.querySelectorAll("[data-k]").forEach(function (el) { intake[el.dataset.k] = el.value.trim(); });
      try { await t.post("/api/os/" + encodeURIComponent(id), { intake: intake }, "PATCH"); t.toast("Saved."); t.go("#osb/" + id); }
      catch (e) { $("msg").innerHTML = '<span class="err">' + h(say(e)) + "</span>"; }
    });
  }

  // ── Edit the scores ────────────────────────────────────────────────────
  async function osscores(id) {
    var t = T();
    if (!t.atLeast("member")) return t.go("#osb/" + id);
    var d = await t.api("/api/os/" + encodeURIComponent(id));
    var b = d.build, src = (b.score.draft && b.score.draft.pillars) || b.score.approved || {};
    var rows = PILLARS.map(function (k) {
      var p = src[k] || { score: "", evidence: "", gap: "" };
      return '<section class="card"><div class="row"><h2 class="name grow" style="margin:0;font-size:16px">' + h(pname(b.vertical, k)) + '</h2><input class="input" id="s_' + k + '" type="number" min="0" max="100" step="1" inputmode="numeric" value="' + h(p.score) + '" style="width:92px;text-align:center" aria-label="Score"></div>' +
        '<div class="field"><label class="label" for="e_' + k + '">Evidence <small>(from their answers)</small></label><textarea class="textarea" id="e_' + k + '" style="min-height:70px">' + h(p.evidence === "Insufficient data in the intake." ? "" : p.evidence) + "</textarea></div>" +
        '<div class="field"><label class="label" for="g_' + k + '">Gap <small>(what\'s missing to reach 80)</small></label><textarea class="textarea" id="g_' + k + '" style="min-height:60px">' + h(p.gap) + "</textarea></div></section>";
    }).join("");
    t.show(null,
      '<div class="screen"><div class="head"><a class="back" href="#osb/' + h(id) + '">' + t.I.back + 'Back</a></div><h1 class="title sm">Five-pillar scores</h1>' +
      '<p class="lede">0–39 broken or missing · 40–69 underperforming · 70–89 solid · 90–100 an advantage. Without evidence, a pillar can\'t score above 40.</p>' + rows +
      '<div class="field"><label class="label" for="sum">Summary <small>(two sentences)</small></label><textarea class="textarea" id="sum" style="min-height:70px">' + h((b.score.draft && b.score.draft.summary) || "") + "</textarea></div>" +
      '<p id="msg" class="body" role="status"></p></div>' +
      '<div class="dock"><div class="dock-inner"><button type="button" class="btn block" id="save">Save the draft</button><span class="note">An approver approves it on the build.</span></div></div>');
    act("save", async function () {
      var pillars = {};
      PILLARS.forEach(function (k) { pillars[k] = { score: Number($("s_" + k).value), evidence: $("e_" + k).value.trim(), gap: $("g_" + k).value.trim() }; });
      try {
        var r = await t.post("/api/os/" + encodeURIComponent(id) + "/scores", { pillars: pillars, summary: $("sum").value.trim() }, "PUT");
        var capped = (r.issues || []).filter(function (i) { return i.issue === "capped_without_evidence"; }).length;
        t.toast(capped ? "Saved. " + capped + " capped at 40 without evidence." : "Saved.");
        t.go("#osb/" + id);
      } catch (e) { $("msg").innerHTML = '<span class="err">' + h(say(e)) + "</span>"; }
    });
  }

  // ── Edit the transcript ────────────────────────────────────────────────
  function linesOut(list, keys) { return (list || []).map(function (x) { return keys.map(function (k) { return x[k] || ""; }).join(" | "); }).join("\n"); }
  function linesIn(text, keys) {
    return String(text || "").split("\n").map(function (l) { return l.trim(); }).filter(Boolean).map(function (l) {
      var parts = l.split("|").map(function (s) { return s.trim(); }), o = {};
      keys.forEach(function (k, i) { o[k] = parts[i] || ""; });
      return o;
    });
  }
  async function ostx(id) {
    var t = T();
    if (!t.atLeast("member")) return t.go("#osb/" + id);
    var d = await t.api("/api/os/" + encodeURIComponent(id));
    var b = d.build, tx = b.transcript.draft || {}, sec = b.transcript.sections || [];
    function area(idn, label, hint, value, rows) { return '<div class="field"><label class="label" for="' + idn + '">' + h(label) + (hint ? " <small>(" + h(hint) + ")</small>" : "") + '</label><textarea class="textarea" id="' + idn + '" style="min-height:' + (rows || 110) + 'px">' + h(value || "") + "</textarea></div>"; }
    t.show(null,
      '<div class="screen"><div class="head"><a class="back" href="#osb/' + h(id) + '">' + t.I.back + 'Back</a></div><h1 class="title sm">Operational Transcript</h1>' +
      '<p class="lede">Only what the intake and the approved scores support. No invented numbers, names or results. The radar draws itself from the scores.</p>' +
      area("ex", "01 · " + sec[0], "one paragraph", tx.executive_summary, 140) +
      area("ln", "03 · " + sec[2], "one per line: name | figure | standing | note", linesOut(tx.lines, ["name", "figure", "standing", "note"])) +
      area("rc", "04 · " + sec[3], "one per line: title | value | Easy, Medium or Hard | note", linesOut(tx.recovery, ["title", "value", "ease", "note"])) +
      area("ro", "05 · " + sec[4], "one paragraph", tx.roster, 110) +
      area("pa", "06 · " + sec[5], "one per line: Focus | text", linesOut(tx.path, ["label", "text"]), 100) +
      area("ac", "07 · " + sec[6], "five, ranked; one per line: title | detail | Client, System or TOJ", linesOut(tx.actions, ["title", "detail", "owner"]), 160) +
      '<p id="msg" class="body" role="status"></p></div>' +
      '<div class="dock"><div class="dock-inner"><button type="button" class="btn block" id="save">Save the draft</button><span class="note">Banned words block approval.</span></div></div>');
    act("save", async function () {
      var body = {
        executive_summary: $("ex").value.trim(),
        lines: linesIn($("ln").value, ["name", "figure", "standing", "note"]),
        recovery: linesIn($("rc").value, ["title", "value", "ease", "note"]),
        roster: $("ro").value.trim(),
        path: linesIn($("pa").value, ["label", "text"]),
        actions: linesIn($("ac").value, ["title", "detail", "owner"]),
      };
      try {
        var r = await t.post("/api/os/" + encodeURIComponent(id) + "/transcript", body, "PUT");
        var bl = r.blockers || [];
        t.toast(bl.length ? "Saved. Still to fix: " + bl.join(", ").replace(/_/g, " ") : "Saved.");
        t.go("#osb/" + id);
      } catch (e) { $("msg").innerHTML = '<span class="err">' + h(say(e)) + "</span>"; }
    });
  }

  // ── The operating brain ────────────────────────────────────────────────
  async function osbrain(id) {
    var t = T();
    var d = await t.api("/api/os/" + encodeURIComponent(id) + "/brain");
    var names = Object.keys(d.files || {});
    t.show(null,
      '<div class="screen">' + t.backBtn("#osb/" + id, "Back") + '<div><p class="kicker">Operating brain</p><h1 class="title sm">' + h(d.slug) + '</h1><p class="lede">Generated ' + h(when(d.generated_at)) + ". The same shape as your other brains: start with CLAUDE.md.</p></div>" +
      names.map(function (n, i) { return '<details class="card tight"' + (i === 0 ? " open" : "") + '><summary class="name mono" style="font-size:14px;cursor:pointer">' + h(n) + '</summary><pre class="mono" style="white-space:pre-wrap;word-break:break-word;font-size:12.5px;line-height:1.5;margin:8px 0 0;color:var(--ink-2)">' + h(d.files[n]) + "</pre></details>"; }).join("") +
      (t.atLeast("member") ? '<a class="btn block" href="/api/os/' + h(id) + '/brain.zip" download>Download ' + h(d.slug) + ".zip</a>" : "") +
      "</div>");
  }

  window.TOJScreens = Object.assign(window.TOJScreens || {}, { os: os, osnew: osnew, osb: osb, osintake: osintake, osscores: osscores, ostx: ostx, osbrain: osbrain });
})();
