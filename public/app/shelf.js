/* The tool shelf in the TOJ app: links the owner adds (a Claude page, a
 * Milanote board, a Google Sheet), each shown to the people it's meant for.
 * The API is routes/team-tools.js. Registers:
 *
 *   #shelf-new           add a tool (owner)
 *   #shelf-edit/<id>     change it, or take it off the shelf (owner)
 *
 * and TOJShelf.section(), the "Team tools" list at the top of Tools.
 * Every link opens outside the app, in a new tab.
 */
(function () {
  "use strict";
  var T = function () { return window.TOJ; };
  var h = function (s) { return T().h(s); };

  var MSG = {
    owner_only: "Only the owner can do that.",
    shelf_not_set_up: "The tool shelf isn't set up on the server yet (migration 031).",
    not_found: "That tool isn't there anymore.",
  };
  var FIELD = { name: "Give it a name (60 characters at most).", url: "Use a full link that starts with https://", about: "Keep the note to 140 characters.", audience: "Pick who sees it." };
  function say(e) {
    var d = e && e.data;
    if (d && d.fields && d.fields.length) return d.fields.map(function (f) { return FIELD[f] || f; }).join(" ");
    return (d && MSG[d.error]) || (e && e.message) || "Something went wrong.";
  }
  var AUD = ["team", "gfs", "studio", "creators", "os", "owners"];
  var AUD_WORDS = { team: "Everyone on the team", gfs: "People with Pylon events", studio: "People with Studio", creators: "People with Creators", os: "People with Operating Systems", owners: "Only owners" };
  var OUT = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v6H4V6h6"/></svg>';

  function host(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return ""; }
  }
  function mark(name) {
    return h(String(name || "?").split(/\s+/).map(function (w) { return w[0] || ""; }).join("").slice(0, 2).toUpperCase());
  }

  // The "Team tools" section for the Tools screen.
  async function section() {
    var t = T(), d;
    try {
      d = await t.api("/api/team-tools");
    } catch (e) {
      if (e.stale) throw e;
      return "";
    }
    var owner = t.isOwner();
    var live = d.tools.filter(function (x) { return !x.archived; });
    var off = owner ? d.tools.filter(function (x) { return x.archived; }) : [];
    var row = function (x) {
      var sub = [x.about, host(x.url), owner && x.audience !== "team" ? AUD_WORDS[x.audience] : null].filter(Boolean).join(" · ");
      return '<div class="li shelf-li"><a class="shelf-go" href="' + h(x.url) + '" target="_blank" rel="noopener noreferrer"><div class="ico shelf-mark" aria-hidden="true">' + mark(x.name) + '</div><div class="grow"><div class="name" style="font-size:15.5px">' + h(x.name) + '</div><div class="sub">' + h(sub) + "</div></div>" + OUT + '<span class="sr"> (opens in a new tab)</span></a>' +
        (owner ? '<a class="btn small soft" href="#shelf-edit/' + h(x.id) + '" aria-label="Change ' + h(x.name) + '">Edit</a>' : "") + "</div>";
    };
    if (!d.set_up) return owner ? '<section class="sec"><h2 class="sec-h">Team tools</h2><p class="empty">' + h(MSG.shelf_not_set_up) + "</p></section>" : "";
    if (!live.length && !owner) return "";
    return '<section class="sec"><div class="head"><h2 class="sec-h">Team tools</h2>' + (owner ? '<a class="btn small" href="#shelf-new">' + t.I.plus.replace("<svg", '<svg width="16" height="16"') + "Add a tool</a>" : "") + "</div>" +
      (live.length ? '<div class="list">' + live.map(row).join("") + "</div>" : '<p class="empty">Add the tools your team uses: a Claude page, a Milanote board, a Google Sheet. You choose who sees each one.</p>') +
      (off.length ? '<details class="shelf-off"><summary class="sub">Off the shelf (' + off.length + ")</summary><div class=\"list\">" + off.map(row).join("") + "</div></details>" : "") +
      "</section>";
  }

  function form(x) {
    return '<form id="shForm" class="card" novalidate>' +
      '<label class="field"><span class="label">Name</span><input class="input" name="name" maxlength="60" required value="' + h(x ? x.name : "") + '" placeholder="Bookings Secret Maker"></label>' +
      '<label class="field"><span class="label">Link</span><input class="input" name="url" type="url" inputmode="url" maxlength="2000" required value="' + h(x ? x.url : "") + '" placeholder="https://"></label>' +
      '<label class="field"><span class="label">What it does <small>(optional)</small></span><input class="input" name="about" maxlength="140" value="' + h(x && x.about ? x.about : "") + '" placeholder="Makes a new secret for the booking form"></label>' +
      '<label class="field"><span class="label">Who sees it</span><select class="input" name="audience">' + AUD.map(function (a) { return '<option value="' + a + '"' + ((x ? x.audience : "team") === a ? " selected" : "") + ">" + h(AUD_WORDS[a]) + "</option>"; }).join("") + "</select></label>" +
      '<p class="sub" style="margin:0">It opens in a new tab. Don\'t add links that sign someone in or hold minors\' details.</p>' +
      '<button type="submit" class="btn block">' + (x ? "Save" : "Add it") + "</button>" +
      '<p class="body" id="shMsg" role="status" style="margin:0"></p></form>';
  }
  function values(f) {
    return { name: f.name.value, url: f.url.value.trim(), about: f.about.value, audience: f.audience.value };
  }
  function ownerOnly() {
    var t = T();
    if (!t.state.me || !t.state.me.team || !t.isOwner()) { t.go("#tools"); return false; }
    return true;
  }

  async function shelfNew() {
    if (!ownerOnly()) return;
    var t = T();
    t.show("tools", '<div class="screen">' + t.backBtn("#tools", "Tools") + '<h1 class="title sm">Add a tool</h1>' + form(null) + "</div>");
    document.getElementById("shForm").addEventListener("submit", async function (e) {
      e.preventDefault();
      try {
        await t.post("/api/team-tools", values(e.target));
        t.toast("Added to Tools.");
        t.go("#tools");
      } catch (er) {
        if (!er.stale) document.getElementById("shMsg").innerHTML = '<span class="err">' + h(say(er)) + "</span>";
      }
    });
  }

  async function shelfEdit(id) {
    if (!ownerOnly()) return;
    var t = T();
    t.show("tools", '<div class="screen">' + t.backBtn("#tools", "Tools") + '<div class="spin"></div></div>');
    var x = ((await t.api("/api/team-tools")).tools || []).filter(function (y) { return y.id === id; })[0];
    if (!x) return t.show("tools", '<div class="screen">' + t.backBtn("#tools", "Tools") + '<p class="body err">' + h(MSG.not_found) + "</p></div>");
    t.show("tools",
      '<div class="screen">' + t.backBtn("#tools", "Tools") + '<h1 class="title sm">' + h(x.name) + "</h1>" + form(x) +
      '<section class="card"><h2 class="sec-h">' + (x.archived ? "Off the shelf" : "Take it off the shelf") + '</h2><p class="body" style="margin:0">' +
      (x.archived ? "Nobody sees it now. Put it back to show it again." : "Hides it from everyone. You can put it back later.") + "</p>" +
      '<button type="button" class="btn ghost" id="shArchive">' + (x.archived ? "Put it back" : "Take it off") + "</button></section></div>");
    document.getElementById("shForm").addEventListener("submit", async function (e) {
      e.preventDefault();
      try {
        await t.post("/api/team-tools/" + x.id, values(e.target), "PATCH");
        t.toast("Saved.");
        t.go("#tools");
      } catch (er) {
        if (!er.stale) document.getElementById("shMsg").innerHTML = '<span class="err">' + h(say(er)) + "</span>";
      }
    });
    document.getElementById("shArchive").addEventListener("click", async function () {
      try {
        await t.post("/api/team-tools/" + x.id, { archived: !x.archived }, "PATCH");
        t.toast(x.archived ? "Back on the shelf." : "Taken off the shelf.");
        t.go("#tools");
      } catch (er) {
        if (!er.stale) document.getElementById("shMsg").innerHTML = '<span class="err">' + h(say(er)) + "</span>";
      }
    });
  }

  window.TOJShelf = { section: section };
  window.TOJScreens = Object.assign(window.TOJScreens || {}, { "shelf-new": shelfNew, "shelf-edit": shelfEdit });
})();
