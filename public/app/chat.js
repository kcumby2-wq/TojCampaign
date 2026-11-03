/* Team chat in the TOJ app. Registers screens for app.js's router (the API is
 * routes/chat.js; the rules, utils/chat.js):
 *
 *   #chat                 your rooms and direct messages
 *   #chat/<room id>       a room
 *   #chat-room/<id>       who's in it, mute, rename, add or remove people, leave
 *   #chat-people          start a direct message
 *   #chat-new             make a room (owner, approvers)
 *   #chat-stop/<event id> a Pylon stop's room (from the event plan)
 *
 * The team only. Text only: no photos or video. Messages can't carry email
 * addresses or phone numbers, and athletes come up by team and jersey number.
 * A room checks for new messages every few seconds while it's on screen.
 */
(function () {
  "use strict";
  var T = function () { return window.TOJ; };
  var h = function (s) { return T().h(s); };
  var app = function () { return document.getElementById("app"); };

  var MSG = {
    chat_not_set_up: "Chat isn't set up on the server yet (migration 026).",
    chat_join_first: "Join chat first.",
    chat_contact_details: "Leave out email addresses and phone numbers. Chat is the contact channel here, and families' details stay in the event's tools.",
    chat_too_fast: "That's a lot of messages at once. Wait a minute.",
    chat_dm_gone: "They're no longer on the team, so this conversation is closed.",
    chat_message_removed: "That message was removed.",
    adult_required: "Confirm you're 18 or older to join.",
    name_required: "Pick the name people see.",
    name_too_long: "Use 40 characters or fewer.",
    title_required: "Name the room.",
    title_too_long: "Use 60 characters or fewer.",
    body_required: "Write something first.",
    body_too_long: "Keep it under 2,000 characters.",
    person_not_found: "That person isn't on the team anymore.",
    person_required: "Pick someone.",
    too_many_people: "A room holds up to 60 people.",
    not_yours: "That's not your message.",
    cant_leave: "You can only leave rooms you were added to.",
    role_too_low: "Owners and approvers make rooms.",
    not_found: "That room isn't here, or it isn't yours to read.",
    name_taken: "Someone on the team already goes by that name. Add an initial.",
    adults_only: "Chat is for adults on the team.",
  };
  function say(e) {
    var d = e && e.data;
    var code = d && d.error;
    return (code && MSG[code]) || (d && d.hint) || (e && e.message) || "Something went wrong.";
  }
  function svg(path, size) { return '<svg viewBox="0 0 24 24" width="' + (size || 20) + '" height="' + (size || 20) + '" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + "</svg>"; }
  var ICON = {
    chat: svg('<path d="M4 5.5h16v10H9l-5 4z"/>', 22),
    room: svg('<path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16"/>', 22),
    pin: svg('<path d="M12 21s-6-5.4-6-10a6 6 0 0 1 12 0c0 4.6-6 10-6 10z"/><circle cx="12" cy="11" r="2.2"/>', 22),
    mute: svg('<path d="M4 9v6h4l5 4V5L8 9z"/><path d="m17 9 4 6M21 9l-4 6"/>', 16),
    more: svg('<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>', 18),
    people: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><circle cx="17" cy="9" r="2.8"/><path d="M16 14.6c2.7.2 4.6 1.9 5.3 4.9"/>', 22),
  };
  var REGION = { west: "West", south_central: "South Central", northeast: "Northeast", southeast: "Southeast", midwest: "Midwest" };

  function initials(name) {
    var parts = String(name || "?").replace(/[^A-Za-z0-9\s'-]/g, "").trim().split(/\s+/).filter(Boolean);
    return parts.length ? ((parts[0][0] || "") + (parts[1] ? parts[1][0] : "")).toUpperCase() : "?";
  }
  function day(d) {
    if (!d) return "";
    return new Date(String(d).slice(0, 10) + "T12:00:00Z").toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric" });
  }
  function dates(ev) { return !ev ? "" : ev.starts_on === ev.ends_on ? day(ev.starts_on) : day(ev.starts_on) + "–" + day(ev.ends_on); }
  function clock(iso) { return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); }
  function dayKey(iso) { var d = new Date(iso); return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate(); }
  function dayLabel(iso) {
    var d = new Date(iso), n = new Date();
    var y = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1);
    if (dayKey(iso) === dayKey(n.toISOString())) return "Today";
    if (d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate()) return "Yesterday";
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() === n.getFullYear() ? undefined : "numeric" });
  }
  function when(iso) {
    if (!iso) return "";
    return dayKey(iso) === dayKey(new Date().toISOString()) ? clock(iso) : new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function bind(sel, ev, fn) { app().querySelectorAll(sel).forEach(function (el) { el.addEventListener(ev, function (e) { fn(el, e); }); }); }
  function loading(tab, back) { T().show(tab, '<div class="screen">' + (back || "") + '<div class="spin" aria-label="Loading"></div></div>'); }
  function head(title, right, lede) {
    return '<div class="head"><div class="grow"><h1 class="title' + (title.length > 18 ? " sm" : "") + '">' + h(title) + "</h1>" + (lede ? '<p class="lede">' + h(lede) + "</p>" : "") + "</div>" + (right || "") + "</div>";
  }
  function teamRow() {
    return '<a class="li list" href="#team" style="border-radius:16px"><div class="ico" style="width:36px;height:36px;border-radius:9px">' + ICON.people + '</div><div class="grow"><div class="name" style="font-size:15px">Team</div><div class="sub">People, invites, notifications and your account</div></div>' + T().I.chev + "</a>";
  }

  // Text people wrote: links open in a new tab, @names of people in the room
  // stand out, line breaks stay. Everything is escaped first.
  function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  function plain(s, names) {
    var e = h(s);
    if (names && names.length) {
      var re = new RegExp("@(" + names.slice().sort(function (a, b) { return b.length - a.length; }).map(function (n) { return escRe(h(n)); }).join("|") + ")(?![A-Za-z0-9])", "gi");
      e = e.replace(re, '<b class="at">@$1</b>');
    }
    return e.replace(/\n/g, "<br>");
  }
  function rich(raw, names) {
    var out = "", last = 0, re = /https?:\/\/[^\s<>"']+/g, m;
    raw = String(raw || "");
    while ((m = re.exec(raw))) {
      var url = m[0].replace(/[.,!?;:)\]]+$/, "");
      out += plain(raw.slice(last, m.index), names);
      out += '<a href="' + h(url) + '" target="_blank" rel="noopener noreferrer nofollow">' + h(url) + "</a>";
      last = m.index + url.length;
      re.lastIndex = last;
    }
    return out + plain(raw.slice(last), names);
  }

  // ── Merging what the server sends into what's on screen ─────────────────
  // By id, in id order. A message already shown takes the server's latest
  // text, removal and edit mark; with onlyUpdate, nothing new is added.
  function merge(list, incoming, onlyUpdate) {
    var byId = {};
    list.forEach(function (m) { byId[m.id] = m; });
    var changed = false, added = [];
    (incoming || []).forEach(function (m) {
      var have = byId[m.id];
      if (have) {
        if (have.body !== m.body || have.removed !== m.removed || have.edited !== m.edited) {
          have.body = m.body; have.removed = m.removed; have.edited = m.edited;
          changed = true;
        }
      } else if (!onlyUpdate) {
        byId[m.id] = m;
        added.push(m);
        changed = true;
      }
    });
    var out = added.length ? list.concat(added).sort(function (a, b) { return a.id - b.id; }) : list;
    return { list: out, changed: changed, added: added };
  }

  // ── The tab's unread count ───────────────────────────────────────────────
  // Checked every 45 seconds while the app is on screen, outside the screens'
  // own polling, so it keeps going on every screen.
  var unreadOff = false;
  function paintDot(n) {
    var s = T() && T().state;
    if (s) s.chatUnread = n;
    var dot = document.getElementById("chatDot");
    if (!dot) return;
    dot.hidden = !n;
    dot.textContent = n > 99 ? "99+" : String(n || "");
  }
  async function refreshUnread() {
    var s = T() && T().state;
    if (unreadOff || !s || !s.me || !s.me.authenticated || !s.me.team || document.hidden) return;
    try {
      var r = await fetch("/api/chat/unread", { credentials: "same-origin", cache: "no-store" });
      if (r.status === 503) { var d503 = await r.json().catch(function () { return {}; }); if (d503.error === "chat_not_set_up") unreadOff = true; return; }
      if (!r.ok) return;
      var d = await r.json();
      paintDot(d.unread_total || 0);
    } catch (e) {}
  }
  setInterval(refreshUnread, 45000);
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) return;
    refreshUnread();
    if (current && current.poll) current.poll(true);
  });
  setTimeout(refreshUnread, 1500);

  // ── Joining ──────────────────────────────────────────────────────────────
  async function hello(next, suggested) {
    var t = T();
    if (suggested === undefined) {
      try { suggested = (await t.api("/api/chat/me")).suggested_name || ""; } catch (e) { suggested = ""; }
    }
    t.show("chat",
      '<div class="screen">' + head("Chat", "", "Rooms for each Pylon stop and region, and direct messages, for the team.") +
      '<section class="card"><h2 class="sec-h">Before you start</h2>' +
      '<ul style="margin:0;padding-left:20px;color:var(--ink-2);font-size:14.5px;line-height:1.5;display:flex;flex-direction:column;gap:6px">' +
      "<li>Chat is text only. Photos and video stay in the event's tools, where consent is checked.</li>" +
      "<li>Talk about athletes by team and jersey number. No names, contact details, film links, permission flags or takedown reasons.</li>" +
      "<li>Messages can't carry email addresses or phone numbers.</li>" +
      "<li>Kyron can remove any message.</li></ul></section>" +
      '<label class="field"><span class="label">The name people see</span><input class="input" id="chName" maxlength="40" autocomplete="name" value="' + h(suggested) + '"></label>' +
      '<label class="check"><span class="grow"><b style="font-size:15px">I\'m 18 or older</b><span class="sub" style="display:block">Chat is for adults on the team.</span></span><input type="checkbox" class="switch" id="chAdult"></label>' +
      '<p id="chMsg" class="body" role="status"></p>' +
      '<button type="button" class="btn block" id="chGo">Start chatting</button>' +
      teamRow() + "</div>");
    document.getElementById("chGo").addEventListener("click", async function (e) {
      var btn = e.currentTarget;
      btn.disabled = true;
      try {
        await t.post("/api/chat/me", { name: document.getElementById("chName").value, adult: document.getElementById("chAdult").checked });
        t.go(next || "#chat");
      } catch (err) {
        btn.disabled = false;
        document.getElementById("chMsg").innerHTML = '<span class="err">' + h(say(err)) + "</span>";
      }
    });
  }
  function notSetUp(tab) {
    T().show(tab || "chat", '<div class="screen">' + head("Chat") + '<section class="card"><p class="body">Chat isn\'t set up on the server yet. Kyron applies migration 026 in Supabase, and then it\'s here.</p></section>' + teamRow() + "</div>");
  }
  // A screen's request failed: the right screen for why.
  function failed(e, next) {
    var code = e && e.data && e.data.error;
    if (code === "chat_join_first") { hello(next); return true; }
    if (code === "chat_not_set_up") { notSetUp(); return true; }
    return false;
  }

  // ── Rooms and messages ───────────────────────────────────────────────────
  function roomSub(r) {
    if (r.kind === "dm") return r.other_role || "";
    if (r.kind === "stop") return [dates(r.event), REGION[r.region] || ""].filter(Boolean).join(" · ");
    if (r.kind === "region") return "Everyone with Pylon events in " + (REGION[r.region] || "the region");
    if (r.kind === "all") return "Everyone with Pylon events";
    return r.people + (r.people === 1 ? " person" : " people");
  }
  function roomIcon(r) {
    if (r.kind === "dm") return '<span class="avatar" style="width:40px;height:40px;border-width:0;background:#22364F;font-size:13.5px">' + h(initials(r.title)) + "</span>";
    return '<div class="ico" style="width:40px;height:40px;border-radius:11px">' + (r.kind === "stop" ? ICON.pin : r.kind === "topic" ? ICON.chat : ICON.room) + "</div>";
  }
  function roomRow(r) {
    var last = r.last ? (r.last.removed ? r.last.by + ": message removed" : r.last.by + ": " + r.last.text) : roomSub(r);
    return '<a class="li" href="#chat/' + h(r.id) + '">' + roomIcon(r) +
      '<div class="grow"><div class="name" style="font-size:15.5px;' + (r.unread && !r.muted ? "" : "font-weight:600") + '">' + h(r.title) + "</div>" +
      '<div class="sub" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + h(last) + "</div></div>" +
      '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">' +
      (r.last ? '<span class="sub" style="font-size:12px">' + h(when(r.last.at)) + "</span>" : "") +
      (r.muted ? '<span class="sub" aria-label="Muted" title="Muted">' + ICON.mute + "</span>" : r.unread ? '<span class="badge gold">' + h(r.unread > 99 ? "99+" : r.unread) + "</span>" : "") +
      "</div></a>";
  }

  var homeSig = "";
  function scheduleHome() {
    T().later(function again() {
      if (location.hash !== "#chat") return;
      if (document.hidden) return T().later(again, 15000);
      home(true).catch(function () {});
    }, 15000);
  }
  async function home(quiet) {
    var t = T();
    if (!quiet) { loading("chat"); homeSig = ""; }
    var d;
    try { d = await t.api("/api/chat"); } catch (e) { if (e.stale) throw e; if (quiet) return scheduleHome(); if (failed(e, "#chat")) return; throw e; }
    if (!d.me) return hello("#chat");
    paintDot(d.unread_total);
    // Every 15 seconds: redraw only when something changed, and without the
    // whole list being read out again.
    var sig = JSON.stringify([d.can_make_rooms, d.rooms.map(function (r) { return [r.id, r.title, r.unread, r.muted, r.last && r.last.at, r.last && r.last.text]; })]);
    if (quiet && sig === homeSig) return scheduleHome();
    homeSig = sig;
    if (quiet) app().setAttribute("aria-live", "off");
    var dms = d.rooms.filter(function (r) { return r.kind === "dm"; });
    var rooms = d.rooms.filter(function (r) { return r.kind === "all" || r.kind === "region" || r.kind === "topic"; });
    var stops = d.rooms.filter(function (r) { return r.kind === "stop"; });
    function sec(title, list, empty) {
      return '<section class="sec"><h2 class="sec-h">' + h(title) + "</h2>" + (list.length ? '<div class="list">' + list.map(roomRow).join("") + "</div>" : '<p class="empty">' + h(empty) + "</p>") + "</section>";
    }
    t.show("chat",
      '<div class="screen">' +
      head("Chat", '<a class="btn small" href="#chat-people">' + t.I.plus.replace("<svg", '<svg width="16" height="16"') + "Message</a>", "You're " + d.me.name + ".") +
      (d.can_make_rooms ? '<a class="li list" href="#chat-new" style="border-radius:16px"><div class="ico" style="width:36px;height:36px;border-radius:9px">' + ICON.chat + '</div><div class="grow"><div class="name" style="font-size:15px">Make a room</div><div class="sub">For a crew, a project or a partner, with the people you pick</div></div>' + t.I.chev + "</a>" : "") +
      sec("Direct messages", dms, "No direct messages yet. Tap Message to start one.") +
      sec("Rooms", rooms, t.hasTool("gfs") ? "No rooms yet." : "No rooms yet. Owners and approvers make them, and add you.") +
      (t.hasTool("gfs") ? sec("Stops", stops, "A stop's room shows up here once someone writes in it. Open one from the event plan.") : "") +
      teamRow() + "</div>");
    scheduleHome();
  }

  // The open room, for the visibility handler.
  var current = null;

  async function room(id) {
    var t = T();
    loading(null, t.backBtn("#chat", "Chat"));
    var res;
    try {
      res = await Promise.all([t.api("/api/chat/rooms/" + encodeURIComponent(id)), t.api("/api/chat/rooms/" + encodeURIComponent(id) + "/messages?read=1")]);
    } catch (e) {
      if (e.stale) throw e;
      if (failed(e, "#chat/" + id)) return;
      t.show(null, '<div class="screen">' + t.backBtn("#chat", "Chat") + '<p class="body err">' + h(say(e)) + "</p></div>");
      return;
    }
    var info = res[0].room, page = res[1];
    var msgs = page.messages.slice();
    var more = page.more;
    // "New" goes above the first unread message from someone else, unless
    // there's nothing older on screen to set it apart from.
    var firstNew = (msgs.find(function (m) { return !m.mine && !m.removed && m.id > page.read_upto; }) || {}).id || null;
    if (firstNew && msgs.length && msgs[0].id === firstNew) firstNew = null;
    var names = info.people.map(function (p) { return p.name; });
    var sub = info.kind === "stop" && info.event ? dates(info.event) + " · " + (REGION[info.region] || "") : info.audience;
    var canPost = info.can.post;

    t.show(null,
      '<div class="screen chat-room">' +
      '<div class="head" style="align-items:center">' + t.backBtn("#chat", "Chat") + '<a class="btn small soft" href="#chat-room/' + h(info.id) + '">' + (info.muted ? ICON.mute : "") + "Details</a></div>" +
      '<div><h1 class="title sm" style="overflow-wrap:anywhere">' + h(info.title) + '</h1><p class="lede">' + h(sub) + "</p></div>" +
      '<p class="chat-rule">' + h(info.rule) + "</p>" +
      '<button type="button" class="btn small ghost" id="older"' + (more ? "" : " hidden") + ">Earlier messages</button>" +
      '<div id="msgs" class="msgs" aria-label="Messages"></div>' +
      '<p class="sr-only" id="announce" aria-live="polite"></p>' +
      '<button type="button" class="newpill" id="jump" hidden>New messages</button>' +
      "</div>" +
      '<div class="dock"><div class="dock-inner">' +
      (canPost
        ? '<div id="mention" class="mention-list" role="listbox" hidden></div>' +
          '<div class="composer"><textarea class="input" id="box" rows="1" maxlength="2000" aria-label="Message" placeholder="Message ' + h(info.kind === "dm" ? info.title : info.title) + '"></textarea>' +
          '<button type="button" class="btn" id="send" aria-label="Send">Send</button></div>' +
          '<p id="sendMsg" class="note" role="status" hidden></p>'
        : '<p class="note">' + h(info.other_gone ? "They're no longer on the team, so this conversation is closed." : "You can read this room.") + "</p>") +
      "</div></div>");

    // The room redraws itself as messages come in; one line announces them
    // instead of the whole page.
    app().setAttribute("aria-live", "off");
    // The composer grows with what's typed (and with an error under it): keep
    // the last message clear of it.
    var list = document.getElementById("msgs");
    function nearBottom() { return window.innerHeight + window.scrollY >= document.body.scrollHeight - 220; }
    function toBottom() { window.scrollTo(0, document.body.scrollHeight); }
    var dock = app().querySelector(".dock");
    if (dock && window.ResizeObserver) new ResizeObserver(function () {
      if (!dock.isConnected) return;
      var stay = nearBottom();
      app().style.paddingBottom = dock.offsetHeight + 24 + "px";
      if (stay) toBottom();
    }).observe(dock);

    function bubble(m) {
      var actions = !m.removed && (m.mine || info.can.remove_any);
      return '<div class="msg' + (m.mine ? " mine" : "") + '" data-id="' + h(m.id) + '">' +
        (m.removed ? '<div class="bubble gone">Message removed</div>' : '<div class="bubble">' + rich(m.body, names) + (m.edited ? ' <span class="edited">(edited)</span>' : "") + "</div>") +
        (actions ? '<button type="button" class="msg-more" data-more="' + h(m.id) + '" aria-label="Message options">' + ICON.more + "</button>" : "") +
        "</div>";
    }
    function draw(keepScroll) {
      var html = "", lastDay = "", lastAuthor = null, lastAt = 0;
      if (!msgs.length) html = '<p class="empty" style="text-align:center;padding:28px 0">No messages yet. Say hello.</p>';
      msgs.forEach(function (m) {
        var k = dayKey(m.at);
        if (k !== lastDay) { html += '<div class="day-sep"><span>' + h(dayLabel(m.at)) + "</span></div>"; lastDay = k; lastAuthor = null; }
        if (firstNew && m.id === firstNew) { html += '<div class="new-sep"><span>New</span></div>'; lastAuthor = null; }
        var aid = m.author ? m.author.id : "gone";
        var at = new Date(m.at).getTime();
        if (aid !== lastAuthor || at - lastAt > 5 * 60000) {
          html += '<div class="msg-head' + (m.mine ? " mine" : "") + '"><b>' + h(m.mine ? "You" : m.author ? m.author.name : "Former teammate") + "</b>" + (m.author && m.author.role && !m.mine ? ' <span class="role">' + h(m.author.role) + "</span>" : "") + " <span>" + h(clock(m.at)) + "</span></div>";
        }
        lastAuthor = aid; lastAt = at;
        html += bubble(m);
      });
      var y = window.scrollY, hgt = document.body.scrollHeight;
      list.innerHTML = html;
      if (keepScroll) window.scrollTo(0, y + (document.body.scrollHeight - hgt));
    }
    draw();
    if (firstNew) {
      var sep = list.querySelector(".new-sep");
      if (sep) sep.scrollIntoView({ block: "center" }); else toBottom();
    } else toBottom();

    // Options on a message: edit (yours), remove (yours; Kyron any).
    list.addEventListener("click", function (e) {
      var b = e.target.closest("[data-more]");
      if (!b) return;
      var m = msgs.find(function (x) { return String(x.id) === b.dataset.more; });
      if (!m) return;
      var row = b.closest(".msg");
      var open = row.querySelector(".msg-menu");
      if (open) { open.remove(); return; }
      list.querySelectorAll(".msg-menu").forEach(function (x) { x.remove(); });
      var menu = document.createElement("div");
      menu.className = "msg-menu";
      menu.innerHTML = (m.mine ? '<button type="button" data-act="edit">Edit</button>' : "") + '<button type="button" data-act="remove" class="err">Remove</button>';
      row.appendChild(menu);
      menu.addEventListener("click", async function (ev) {
        var act = ev.target.dataset && ev.target.dataset.act;
        if (act === "remove") {
          if (!ev.target.dataset.armed) { ev.target.dataset.armed = "1"; ev.target.textContent = "Tap again to remove"; return; }
          try { await t.post("/api/chat/messages/" + m.id, {}, "DELETE"); m.removed = true; m.body = null; draw(true); } catch (err) { t.toast(say(err)); }
        } else if (act === "edit") {
          menu.remove();
          var bub = row.querySelector(".bubble");
          bub.outerHTML = '<div class="bubble editing"><textarea class="input" rows="3" maxlength="2000">' + h(m.body) + '</textarea><div class="btn-row" style="margin-top:8px"><button type="button" class="btn small soft" data-edit="cancel">Cancel</button><button type="button" class="btn small" data-edit="save">Save</button></div></div>';
          var ed = row.querySelector(".editing");
          ed.scrollIntoView({ block: "center" });
          ed.querySelector("textarea").focus({ preventScroll: true });
          ed.addEventListener("click", async function (x) {
            var which = x.target.dataset && x.target.dataset.edit;
            if (which === "cancel") return draw(true);
            if (which !== "save") return;
            x.target.disabled = true;
            try {
              var r2 = await t.post("/api/chat/messages/" + m.id, { body: ed.querySelector("textarea").value }, "PATCH");
              m.body = r2.message.body; m.edited = true; draw(true);
            } catch (err) { x.target.disabled = false; t.toast(say(err)); }
          });
        }
      });
    });

    document.getElementById("older").addEventListener("click", async function (e) {
      var btn = e.currentTarget;
      btn.disabled = true;
      try {
        var p = await t.api("/api/chat/rooms/" + encodeURIComponent(id) + "/messages?before=" + (msgs.length ? msgs[0].id : ""));
        msgs = merge(msgs, p.messages).list;
        more = p.more;
        btn.hidden = !more;
        draw(true);
      } catch (err) { if (!err.stale) t.toast(say(err)); }
      btn.disabled = false;
    });

    var jump = document.getElementById("jump");
    jump.addEventListener("click", function () { jump.hidden = true; toBottom(); });
    window.addEventListener("scroll", function onScroll() { if (!document.getElementById("jump")) return window.removeEventListener("scroll", onScroll); if (nearBottom()) jump.hidden = true; }, { passive: true });

    // New messages every 4 seconds while the room is on screen; edits and
    // removals of recent ones every 30.
    //
    // cursor is the highest id the server has sent this screen. Your own
    // sends never move it, so a message someone posts just before yours is
    // still fetched. Each check reaches 10 ids back, because ids can commit
    // a moment out of order, and the merge drops what's already shown.
    var polls = 0;
    var cursor = msgs.length ? msgs[msgs.length - 1].id : 0;
    var announce = document.getElementById("announce");
    var url = "/api/chat/rooms/" + encodeURIComponent(id) + "/messages";
    // One poll at a time: a newer poll (the app coming back on screen) cancels
    // the one that was waiting.
    var seq = 0;
    function onScreen() { return current === here && location.hash === "#chat/" + id; }
    function schedule() { var my = ++seq; t.later(function () { if (my === seq) poll(); }, 4000); }
    async function poll(now) {
      if (!onScreen()) return;
      if (document.hidden && !now) return schedule();
      var my = ++seq;
      try {
        polls++;
        var changed = false, added = [];
        // Everything newer, a page at a time if it's a lot.
        for (var pages = 0; pages < 10; pages++) {
          var p = await t.api(url + "?read=1&after=" + Math.max(0, cursor - 10));
          var r = merge(msgs, p.messages);
          msgs = r.list;
          changed = changed || r.changed;
          added = added.concat(r.added);
          p.messages.forEach(function (m) { if (m.id > cursor) cursor = m.id; });
          if (!p.more) break;
        }
        // Edits and removals of the latest page.
        if (polls % 8 === 0) {
          var latest = await t.api(url);
          var u = merge(msgs, latest.messages, true);
          changed = changed || u.changed;
        }
        var theirs = added.filter(function (m) { return !m.mine; });
        if (theirs.length) announce.textContent = theirs.length === 1 ? "New message from " + (theirs[0].author ? theirs[0].author.name : "a former teammate") : theirs.length + " new messages";
        if (changed) {
          var stay = nearBottom();
          draw(true);
          if (stay) toBottom(); else if (theirs.length) jump.hidden = false;
        }
      } catch (e) { if (e.stale) return; }
      if (my === seq && onScreen()) schedule();
    }
    var here = { id: id, poll: poll };
    current = here;
    schedule();

    if (!canPost) return;
    var box = document.getElementById("box");
    var sendBtn = document.getElementById("send");
    var note = document.getElementById("sendMsg");
    var mention = document.getElementById("mention");
    function grow() { box.style.height = "auto"; box.style.height = Math.min(box.scrollHeight, 150) + "px"; }
    function sayNote(text) { note.hidden = !text; note.innerHTML = text ? '<span class="err">' + h(text) + "</span>" : ""; }
    async function send() {
      var body = box.value;
      if (!body.trim()) return;
      sendBtn.disabled = true;
      try {
        var r = await t.post("/api/chat/rooms/" + encodeURIComponent(id) + "/messages", { body: body });
        msgs = merge(msgs, [r.message]).list;
        firstNew = null;
        box.value = "";
        grow();
        sayNote("");
        draw(true);
        toBottom();
      } catch (e) { if (!e.stale) sayNote(say(e)); }
      sendBtn.disabled = false;
      box.focus();
    }
    sendBtn.addEventListener("click", send);
    var fine = window.matchMedia && window.matchMedia("(pointer: fine)").matches;
    box.addEventListener("keydown", function (e) {
      if (!mention.hidden && (e.key === "Enter" || e.key === "Tab")) {
        var first = mention.querySelector("[data-name]");
        if (first) { e.preventDefault(); pick(first.dataset.name); return; }
      }
      if (e.key === "Escape") { mention.hidden = true; return; }
      if (e.key === "Enter" && !e.shiftKey && (fine || e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
    });
    // "@" + the start of a name: the room's people who match.
    function pick(name) {
      var pos = box.selectionStart, before = box.value.slice(0, pos), after = box.value.slice(pos);
      before = before.replace(/@([^\s@]{0,30})$/, "@" + name + " ");
      box.value = before + after;
      box.selectionStart = box.selectionEnd = before.length;
      mention.hidden = true;
      box.focus();
    }
    box.addEventListener("input", function () {
      grow();
      if (note && !note.hidden) sayNote("");
      var m = /(^|\s)@([^\s@]{0,30})$/.exec(box.value.slice(0, box.selectionStart));
      if (!m) { mention.hidden = true; return; }
      var q = m[2].toLowerCase();
      var hits = info.people.filter(function (p) { return !p.you && p.name.toLowerCase().indexOf(q) === 0; }).slice(0, 6);
      if (!hits.length) { mention.hidden = true; return; }
      mention.innerHTML = hits.map(function (p) { return '<button type="button" role="option" data-name="' + h(p.name) + '"><b>' + h(p.name) + "</b> <span>" + h(p.role) + "</span></button>"; }).join("");
      mention.hidden = false;
    });
    mention.addEventListener("click", function (e) { var b = e.target.closest("[data-name]"); if (b) pick(b.dataset.name); });
  }

  async function chat(arg) {
    current = null;
    if (arg) return room(arg);
    return home();
  }

  // ── Details: who's in it, mute, manage ───────────────────────────────────
  async function details(id) {
    var t = T();
    current = null;
    loading(null, t.backBtn("#chat/" + id, "Back"));
    var info;
    try { info = (await t.api("/api/chat/rooms/" + encodeURIComponent(id))).room; } catch (e) { if (e.stale) throw e; if (failed(e, "#chat-room/" + id)) return; t.show(null, '<div class="screen">' + t.backBtn("#chat", "Chat") + '<p class="body err">' + h(say(e)) + "</p></div>"); return; }
    var everyone = [];
    if (info.can.manage) { try { everyone = (await t.api("/api/chat/people")).people; } catch (e) { if (e.stale) throw e; } }
    var inRoom = {};
    info.people.forEach(function (p) { inRoom[p.id] = 1; });
    var addable = everyone.filter(function (p) { return !inRoom[p.id]; });
    var people = info.people.map(function (p) {
      return '<div class="li" style="cursor:default"><span class="avatar" style="width:36px;height:36px;border-width:0;background:#22364F;font-size:12.5px">' + h(initials(p.name)) + '</span><div class="grow"><div class="name" style="font-size:15px">' + h(p.name) + (p.you ? ' <span class="sub">(you)</span>' : "") + '</div><div class="sub">' + h(p.role) + "</div></div>" +
        (info.can.manage && !p.you ? '<button type="button" class="btn small danger" data-drop="' + h(p.id) + '" aria-label="Take ' + h(p.name) + ' out of the room">Remove</button>' : "") + "</div>";
    }).join("");
    t.show(null,
      '<div class="screen">' + t.backBtn("#chat/" + id, info.title) +
      head(info.kind === "dm" ? info.title : "Details", "", info.audience) +
      (info.can.manage ? '<label class="field"><span class="label">Room name</span><div class="row"><input class="input" id="rName" maxlength="60" value="' + h(info.title) + '"><button type="button" class="btn small soft" id="rRename">Save</button></div></label>' : "") +
      '<label class="check"><span class="grow"><b style="font-size:15px">Mute</b><span class="sub" style="display:block">No notifications from this room, unless someone mentions you.</span></span><input type="checkbox" class="switch" id="rMute"' + (info.muted ? " checked" : "") + "></label>" +
      (info.event ? '<a class="li list" href="#event/' + h(info.event.id) + '" style="border-radius:16px"><div class="ico" style="width:36px;height:36px;border-radius:9px">' + ICON.pin + '</div><div class="grow"><div class="name" style="font-size:15px">The event plan</div><div class="sub">' + h(info.event.name) + "</div></div>" + t.I.chev + "</a>" : "") +
      '<section class="sec"><h2 class="sec-h">Who can read it · ' + info.people.length + "</h2>" + (people ? '<div class="list">' + people + "</div>" : '<p class="empty">Nobody else has joined chat yet.</p>') +
      (info.kind === "all" || info.kind === "region" || info.kind === "stop" ? '<p class="sub" style="margin:0">This follows the team\'s roles and regions. People who haven\'t opened chat yet join when they do.</p>' : "") + "</section>" +
      (info.can.manage && addable.length ? '<section class="sec"><h2 class="sec-h">Add people</h2><div class="list">' + addable.map(function (p) {
        return '<label class="li"><input type="checkbox" data-add="' + h(p.id) + '" style="width:20px;height:20px;accent-color:var(--gold)"><div class="grow"><div class="name" style="font-size:15px">' + h(p.name) + '</div><div class="sub">' + h(p.role) + "</div></div></label>";
      }).join("") + '</div><button type="button" class="btn soft" id="rAdd">Add to the room</button></section>' : "") +
      (info.can.leave ? '<button type="button" class="btn danger" id="rLeave">Leave this room</button>' : "") +
      '<p id="rMsg" class="body" role="status"></p></div>');
    function msg(text, ok) { document.getElementById("rMsg").innerHTML = '<span class="' + (ok ? "okc" : "err") + '">' + h(text) + "</span>"; }
    document.getElementById("rMute").addEventListener("change", async function (e) {
      try { await t.post("/api/chat/rooms/" + id + "/me", { muted: e.target.checked }, "PATCH"); t.toast(e.target.checked ? "Muted." : "Unmuted."); } catch (err) { e.target.checked = !e.target.checked; msg(say(err)); }
    });
    var rn = document.getElementById("rRename");
    if (rn) rn.addEventListener("click", async function () {
      try { await t.post("/api/chat/rooms/" + id, { title: document.getElementById("rName").value }, "PATCH"); t.toast("Renamed."); details(id); } catch (err) { msg(say(err)); }
    });
    var add = document.getElementById("rAdd");
    if (add) add.addEventListener("click", async function () {
      var ids = Array.prototype.map.call(app().querySelectorAll("[data-add]:checked"), function (c) { return c.dataset.add; });
      if (!ids.length) return msg("Pick someone to add.");
      try { await t.post("/api/chat/rooms/" + id, { add: ids }, "PATCH"); t.toast("Added."); details(id); } catch (err) { msg(say(err)); }
    });
    bind("[data-drop]", "click", async function (b) {
      if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Tap again"; return; }
      try { await t.post("/api/chat/rooms/" + id, { remove: [b.dataset.drop] }, "PATCH"); details(id); } catch (err) { msg(say(err)); }
    });
    var leave = document.getElementById("rLeave");
    if (leave) leave.addEventListener("click", async function () {
      if (!leave.dataset.armed) { leave.dataset.armed = "1"; leave.textContent = "Tap again to leave"; return; }
      try { await t.post("/api/chat/rooms/" + id + "/me", { leave: true }, "PATCH"); t.toast("You left the room."); t.go("#chat"); } catch (err) { msg(say(err)); }
    });
  }

  // ── Start a direct message ───────────────────────────────────────────────
  async function peopleScreen() {
    var t = T();
    current = null;
    loading(null, t.backBtn("#chat", "Chat"));
    var d;
    try { d = await t.api("/api/chat/people"); } catch (e) { if (e.stale) throw e; if (failed(e, "#chat-people")) return; throw e; }
    t.show(null,
      '<div class="screen">' + t.backBtn("#chat", "Chat") + head("New message", "", "Everyone on the team who has joined chat.") +
      (d.people.length ? '<div class="list">' + d.people.map(function (p) {
        return '<button type="button" class="li" data-dm="' + h(p.id) + '"><span class="avatar" style="width:38px;height:38px;border-width:0;background:#22364F;font-size:13px">' + h(initials(p.name)) + '</span><div class="grow"><div class="name" style="font-size:15.5px">' + h(p.name) + '</div><div class="sub">' + h(p.role) + "</div></div>" + t.I.chev + "</button>";
      }).join("") + "</div>" : '<p class="empty">Nobody else has joined chat yet. When teammates open Chat, they show up here.</p>') +
      '<p id="pMsg" class="body" role="status"></p></div>');
    bind("[data-dm]", "click", async function (b) {
      b.disabled = true;
      try { var r = await t.post("/api/chat/dm", { person: b.dataset.dm }); t.go("#chat/" + r.room.id); } catch (e) { b.disabled = false; document.getElementById("pMsg").innerHTML = '<span class="err">' + h(say(e)) + "</span>"; }
    });
  }

  // ── Make a room ──────────────────────────────────────────────────────────
  async function newRoom() {
    var t = T();
    current = null;
    if (!(t.isOwner() || t.atLeast("approver"))) return t.go("#chat");
    loading(null, t.backBtn("#chat", "Cancel"));
    var d;
    try { d = await t.api("/api/chat/people"); } catch (e) { if (e.stale) throw e; if (failed(e, "#chat-new")) return; throw e; }
    t.show(null,
      '<div class="screen">' + t.backBtn("#chat", "Cancel") + head("Make a room", "", "Only the people you add can read it. You can add or take people out later.") +
      '<label class="field"><span class="label">Name <small>never an athlete\'s name: it shows in notifications</small></span><input class="input" id="nTitle" maxlength="60" placeholder="3D crew · Dallas"></label>' +
      '<section class="sec"><h2 class="sec-h">People</h2>' + (d.people.length ? '<div class="list">' + d.people.map(function (p) {
        return '<label class="li"><input type="checkbox" data-pick="' + h(p.id) + '" style="width:20px;height:20px;accent-color:var(--gold)"><div class="grow"><div class="name" style="font-size:15px">' + h(p.name) + '</div><div class="sub">' + h(p.role) + "</div></div></label>";
      }).join("") + "</div>" : '<p class="empty">Nobody else has joined chat yet. You can add people later.</p>') + "</section>" +
      '<p id="nMsg" class="body" role="status"></p></div>' +
      '<div class="dock"><div class="dock-inner"><button type="button" class="btn block" id="nGo">Make the room</button></div></div>');
    document.getElementById("nGo").addEventListener("click", async function (e) {
      var btn = e.currentTarget;
      btn.disabled = true;
      var ids = Array.prototype.map.call(app().querySelectorAll("[data-pick]:checked"), function (c) { return c.dataset.pick; });
      try { var r = await t.post("/api/chat/rooms", { title: document.getElementById("nTitle").value, people: ids }); t.go("#chat/" + r.room.id); }
      catch (err) { btn.disabled = false; document.getElementById("nMsg").innerHTML = '<span class="err">' + h(say(err)) + "</span>"; }
    });
  }

  // ── A stop's room, from the event plan ───────────────────────────────────
  async function stopRoom(eventId) {
    var t = T();
    current = null;
    loading(null, t.backBtn("#event/" + eventId, "Event plan"));
    try {
      var r = await t.api("/api/chat/stop/" + encodeURIComponent(eventId));
      location.replace("#chat/" + r.room.id);
    } catch (e) {
      if (e.stale) throw e;
      if (failed(e, "#chat-stop/" + eventId)) return;
      t.show(null, '<div class="screen">' + t.backBtn("#event/" + eventId, "Event plan") + '<p class="body err">' + h(say(e)) + "</p></div>");
    }
  }

  window.TOJChat = { refreshUnread: refreshUnread, merge: merge };
  window.TOJScreens = Object.assign(window.TOJScreens || {}, {
    chat: chat,
    "chat-room": details,
    "chat-people": peopleScreen,
    "chat-new": newRoom,
    "chat-stop": stopRoom,
  });
})();
