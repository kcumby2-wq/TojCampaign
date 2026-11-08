/* The Studio taste library in the TOJ app (migration 041; the API is
 * routes/studio-taste.js): notes on work worth learning from, each with a
 * link to the work and what to take and leave. Never a photo or a copy of
 * the work. Briefs and film directions cite an entry as "Taste 12".
 * Registers screens for app.js:
 *
 *   #taste              search by words or a tag, newest first
 *   #taste-edit/<id>    add a note (<id> "new"), or edit one you added
 */
(function () {
  "use strict";
  var T = function () { return window.TOJ; };
  var h = function (s) { return T().h(s); };
  var KINDS = [["film", "A film"], ["cut", "A cut"], ["look", "A look"], ["sound", "A sound"], ["graphic", "A graphic"], ["caption", "A caption"], ["other", "Other"]];
  var MSG = {
    title: "Give it a title.",
    url: "Add the link to the work (https://…).",
    url_is_an_image: "That's a link to an image file. Link to the page the work is on instead: the library keeps notes and links, never pictures.",
    note: "Say what it is and why it's worth learning from.",
    banned_words: "A word on the TOJ banned list is in it. Say the concrete thing instead.",
    changed_meanwhile: "Someone changed it while you were editing. Open it again.",
    producer_only: "Only whoever added it, or the producer, can change it.",
    not_found: "Not found. It may have been archived.",
    storage_unavailable: "The server can't reach its database right now.",
  };
  function why(e) {
    var d = (e && e.data) || {};
    if (d.error === "refused" && d.reason) return d.reason.charAt(0).toUpperCase() + d.reason.slice(1) + ".";
    if (d.error === "invalid" && d.fields) return d.fields.map(function (f) { return MSG[f] || "Check the " + f.replace(/_/g, " ") + "."; }).join(" ");
    return MSG[d.error] || (e && e.message) || "That didn't work.";
  }
  function guard() { if (!T().atLeast("member") || !T().hasTool("studio")) { T().go("#studio"); return false; } return true; }
  function host(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return ""; } }
  var KIND_LABEL = {};
  KINDS.forEach(function (k) { KIND_LABEL[k[0]] = k[1].replace(/^An? /, ""); });

  // ── The library ──────────────────────────────────────────────────────
  var last = { q: "", tag: "" };
  async function library() {
    if (!guard()) return;
    var t = T(), back = t.backBtn("#studio", "Studio");
    t.show("studio", '<div class="screen">' + back + '<div class="spin"></div></div>');
    var tags = [];
    try { tags = (await t.api("/api/studio-taste/tags")).tags || []; } catch (e) { if (e.stale) throw e; tags = []; }
    t.show("studio",
      '<div class="screen">' + back +
      '<div class="head"><div><p class="kicker">Studio</p><h1 class="title">Taste library</h1></div><a class="btn small soft" href="#taste-edit/new">' + t.I.plus.replace("<svg", '<svg width="16" height="16"') + "Add</a></div>" +
      '<p class="lede">Work worth learning from: a link to it, what it is, and what to take and leave. Briefs cite a note by its number ("Taste 12"): tap a number to copy it. Notes and links only, never pictures of the work.</p>' +
      '<label class="sr" for="tq">Search the library</label><input class="input" id="tq" type="search" placeholder="Search: grain, slow push-in, voice-over…" value="' + h(last.q) + '">' +
      (tags.length ? '<div class="chips" role="group" aria-label="Tags">' + tags.slice(0, 30).map(function (x) { return '<button type="button" class="chip" data-tag="' + h(x.tag) + '" aria-pressed="' + (last.tag === x.tag) + '">' + h(x.tag) + ' <span class="sub" style="font-size:12px">' + x.count + "</span></button>"; }).join("") + "</div>" : "") +
      '<div id="tList"><div class="spin"></div></div></div>');
    var q = document.getElementById("tq");
    var timer = null;
    q.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(function () { last.q = q.value.trim(); load(); }, 300); });
    Array.prototype.forEach.call(document.querySelectorAll("[data-tag]"), function (b) {
      b.addEventListener("click", function () {
        last.tag = last.tag === b.dataset.tag ? "" : b.dataset.tag;
        Array.prototype.forEach.call(document.querySelectorAll("[data-tag]"), function (x) { x.setAttribute("aria-pressed", String(x.dataset.tag === last.tag)); });
        load();
      });
    });
    var hash = location.hash;
    var seq = 0;
    async function load() {
      var my = ++seq;
      var box = document.getElementById("tList");
      var d;
      try {
        d = await t.api("/api/studio-taste?" + new URLSearchParams({ q: last.q, tag: last.tag, limit: "50" }).toString());
      } catch (e) {
        if (e.stale || location.hash !== hash || my !== seq) return;
        box.innerHTML = '<p class="body err">' + h(why(e)) + "</p>";
        return;
      }
      if (location.hash !== hash || my !== seq || !document.getElementById("tList")) return;
      var me = d.me;
      var list = d.entries || [];
      box.innerHTML = list.length ? '<div style="display:flex;flex-direction:column;gap:10px">' + list.map(function (x) {
        var mine = x.added_by === me || (d.can && d.can.producer);
        return '<article class="card tight" style="gap:8px">' +
          '<div class="row" style="align-items:flex-start"><button type="button" class="badge gold mono" style="flex:none;border:0;cursor:pointer" data-ref="' + h(x.ref) + '" aria-label="' + h("Copy " + x.ref) + '">' + h(x.ref) + '</button><div class="grow"><a class="name" style="font-size:15.5px;text-decoration:none;color:var(--ink)" href="' + h(x.url) + '" target="_blank" rel="noopener noreferrer">' + h(x.title) + '</a><div class="sub">' + h([KIND_LABEL[x.kind] || x.kind, host(x.url), String(x.added_by || "").replace(/@.*/, ""), t.ago(x.created_at)].filter(Boolean).join(" · ")) + "</div></div></div>" +
          '<p class="body" style="margin:0;font-size:14.5px">' + h(x.note) + "</p>" +
          (x.take ? '<p class="body" style="margin:0;font-size:14px"><b style="color:var(--ink)">Take:</b> ' + h(x.take) + "</p>" : "") +
          (x.leave ? '<p class="body" style="margin:0;font-size:14px"><b style="color:var(--ink)">Leave:</b> ' + h(x.leave) + "</p>" : "") +
          ((x.tags || []).length ? '<div class="pill-row">' + x.tags.map(function (g) { return '<span class="badge">' + h(g) + "</span>"; }).join("") + "</div>" : "") +
          '<div class="btn-row"><a class="btn soft small" style="flex:2" href="' + h(x.url) + '" target="_blank" rel="noopener noreferrer">Open the work</a>' + (mine ? '<a class="btn ghost small" href="#taste-edit/' + h(x.id) + '">Edit</a>' : "") + "</div></article>";
      }).join("") + "</div>" : '<p class="empty">' + (last.q || last.tag ? "Nothing matches. Try other words, or another tag." : "No notes yet. Add the first piece of work worth learning from.") + "</p>";
      Array.prototype.forEach.call(box.querySelectorAll("[data-ref]"), function (b) {
        b.addEventListener("click", async function () {
          try { await navigator.clipboard.writeText(b.dataset.ref); t.toast(b.dataset.ref + " copied: cite it in a brief."); } catch (e) { t.toast("This browser didn't allow copying."); }
        });
      });
    }
    load();
  }

  // ── Add or edit a note ───────────────────────────────────────────────
  async function edit(id) {
    if (!guard()) return;
    var t = T(), back = t.backBtn("#taste", "Taste library");
    var x = { title: "", url: "", kind: "film", note: "", take: "", leave: "", tags: [] };
    var isNew = id === "new";
    if (!isNew) {
      t.show("studio", '<div class="screen">' + back + '<div class="spin"></div></div>');
      try {
        x = (await t.api("/api/studio-taste/" + encodeURIComponent(id))).entry;
      } catch (e) {
        if (e.stale) throw e;
        return t.show("studio", '<div class="screen">' + back + '<h1 class="title sm">Couldn\'t open it</h1><p class="body err">' + h(why(e)) + "</p></div>");
      }
    }
    var field = function (fid, label, value, o) {
      o = o || {};
      return '<div class="field"><label class="label" for="' + fid + '">' + label + "</label>" + (o.area ? '<textarea class="textarea" id="' + fid + '" maxlength="' + (o.max || 500) + '" style="min-height:' + (o.h || 90) + 'px" placeholder="' + h(o.ph || "") + '">' + h(value || "") + "</textarea>" : '<input class="input" id="' + fid + '" type="' + (o.type || "text") + '" maxlength="' + (o.max || 120) + '" placeholder="' + h(o.ph || "") + '" value="' + h(value || "") + '">') + "</div>";
    };
    t.show(null,
      '<div class="screen">' + back +
      '<div><p class="kicker">Taste library' + (isNew ? "" : " · " + h(x.ref)) + '</p><h1 class="title sm">' + (isNew ? "Add a note" : "Edit the note") + "</h1></div>" +
      field("xTitle", "Title", x.title, { ph: "The title of the work, or what it is" }) +
      field("xUrl", "Link to the work <small>(the page it's on, not an image file)</small>", x.url, { type: "url", max: 500, ph: "https://…" }) +
      '<div class="field"><label class="label" for="xKind">What it is</label><select class="input" id="xKind">' + KINDS.map(function (k) { return '<option value="' + k[0] + '"' + (x.kind === k[0] ? " selected" : "") + ">" + k[1] + "</option>"; }).join("") + "</select></div>" +
      field("xNote", "What it is, and why it's worth learning from", x.note, { area: true, max: 1000, h: 110 }) +
      field("xTake", "Take <small>(what to borrow)</small>", x.take, { area: true, h: 70 }) +
      field("xLeave", "Leave <small>(what not to copy)</small>", x.leave, { area: true, h: 70 }) +
      field("xTags", "Tags <small>(a few words, commas between)</small>", (x.tags || []).join(", "), { max: 200, ph: "grain, voice-over, slow push-in" }) +
      '<p class="privacy">' + T().I.lock + "Notes and a link only: the library never keeps a picture or a copy of the work.</p>" +
      '<p id="xMsg" class="body" role="status"></p>' +
      (isNew ? "" : '<div class="btn-row"><button type="button" class="btn ghost small" id="xArchive">' + (x.archived_at ? "Bring it back" : "Archive it") + "</button></div>") +
      "</div>" +
      '<div class="dock"><div class="dock-inner"><button type="button" class="btn block" id="xSave">' + (isNew ? "Add it" : "Save") + "</button></div></div>");
    var v = function (fid) { return document.getElementById(fid).value.trim(); };
    document.getElementById("xSave").addEventListener("click", async function () {
      var btn = this;
      var body = { title: v("xTitle"), url: v("xUrl"), kind: v("xKind"), note: v("xNote"), take: v("xTake"), leave: v("xLeave"), tags: v("xTags").split(",").map(function (s) { return s.trim(); }).filter(Boolean) };
      btn.disabled = true;
      try {
        var r = isNew ? await t.post("/api/studio-taste", body) : await t.post("/api/studio-taste/" + encodeURIComponent(id), Object.assign({ seen: x.updated_at }, body), "PATCH");
        t.toast((isNew ? "Added as " : "Saved ") + r.entry.ref + ".");
        t.go("#taste");
      } catch (e) {
        btn.disabled = false;
        var m = document.getElementById("xMsg");
        if (m) m.innerHTML = '<span class="err">' + h(why(e)) + "</span>";
      }
    });
    var arch = document.getElementById("xArchive");
    if (arch) arch.addEventListener("click", async function () {
      arch.disabled = true;
      try {
        await t.post("/api/studio-taste/" + encodeURIComponent(id) + "/archive", { archived: !x.archived_at });
        t.toast(x.archived_at ? "Brought back." : "Archived: briefs no longer find it.");
        t.go("#taste");
      } catch (e) { arch.disabled = false; t.toast(why(e)); }
    });
  }

  window.TOJScreens = Object.assign(window.TOJScreens || {}, { taste: library, "taste-edit": edit });
})();
