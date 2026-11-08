/* Studio craft in the TOJ app (migration 040; films.js has the rooms).
 * Registers screens for app.js:
 *
 *   #film-shoot/<id>     shoot mode: call times, the cards' lights, the kit's
 *                        rules for the day, the must-haves and the checklist.
 *                        Ticks stay on this phone, and a copy with no names,
 *                        contacts or places opens when the signal drops.
 *   #film-ghost/<id>     the ghost frame: the archive frame over the live
 *                        camera, for the Same Drill. Nothing leaves the phone.
 *   #film-check/<id>     the delivery check: an export's length, size and name,
 *                        read on the phone and checked against the kit.
 *   #film-graphics/<id>  the graphics: quote cards, letter slides, title, end
 *                        and year cards in the proposed type system (marked
 *                        PROPOSED until Kyron and Coach Hooks approve it).
 */
(function () {
  "use strict";
  var T = function () { return window.TOJ; };
  var F = function () { return window.TOJFilms; };
  var h = function (s) { return T().h(s); };

  // ── PNG marks ────────────────────────────────────────────────────────
  // A tEXt chunk ("Software: TOJ Studio graphics") right after the header:
  // utils/studio-still.js reads it.
  var CRC = (function () { var t = [], c, n, k; for (n = 0; n < 256; n++) { c = n; for (k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(bytes) { var c = 0xffffffff; for (var i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  async function markPng(blob) {
    if (!blob) return blob;
    var buf = new Uint8Array(await blob.arrayBuffer());
    var head = 8 + 25; // the signature, then IHDR (length, type, 13 bytes, CRC)
    var text = "Software\u0000TOJ Studio graphics";
    var body = new Uint8Array(4 + text.length);
    body.set([0x74, 0x45, 0x58, 0x74]); // "tEXt"
    for (var i = 0; i < text.length; i++) body[4 + i] = text.charCodeAt(i);
    var chunk = new Uint8Array(8 + text.length + 4);
    var dv = new DataView(chunk.buffer);
    dv.setUint32(0, text.length);
    chunk.set(body, 4);
    dv.setUint32(8 + text.length, crc32(body));
    var out = new Uint8Array(buf.length + chunk.length);
    out.set(buf.subarray(0, head), 0);
    out.set(chunk, head);
    out.set(buf.subarray(head), head + chunk.length);
    return new Blob([out], { type: "image/png" });
  }

  // ── This phone's storage (never needed; always optional) ─────────────
  function lsGet(k) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* full or blocked: fine */ } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* blocked: fine */ } }
  function lsKeys(prefix) { var out = []; try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf(prefix) === 0) out.push(k); } } catch (e) { /* blocked */ } return out; }
  var SHEET = "toj.shoot.sheet.", TICKS = "toj.shoot.ticks.", DRAFT = "toj.graphics.draft.";
  var SHEET_DAYS = 14;
  // A draft of a graphic lives for this session only, and a day at most.
  function ssGet(k) { try { var v = sessionStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* full or blocked: fine */ } }
  function ssDel(k) { try { sessionStorage.removeItem(k); } catch (e) { /* blocked: fine */ } }
  // At most 10 films' sheets, none older than 14 days.
  function keepSheet(o) {
    lsSet(SHEET + o.film_id, o);
    lsKeys(SHEET).map(function (k) { var v = lsGet(k); return { k: k, at: v && v.saved_at ? Date.parse(v.saved_at) : 0 }; })
      .sort(function (a, b) { return b.at - a.at; })
      .forEach(function (x, i) { if (i >= 10 || Date.now() - x.at > SHEET_DAYS * 864e5) forget(x.k.slice(SHEET.length)); });
  }
  function forget(id) { lsDel(SHEET + id); lsDel(TICKS + id); }
  function tc(ms) { var s = Math.round(ms / 1000); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
  function today() { var n = new Date(); return String(n.getFullYear()) + String(n.getMonth() + 1).padStart(2, "0") + String(n.getDate()).padStart(2, "0"); }
  function checkbox(attr, on, label, sub) {
    return '<label class="li" style="cursor:pointer;border-radius:12px;border:1px solid var(--line);min-height:50px;align-items:flex-start"><input type="checkbox" class="switch" ' + attr + (on ? " checked" : "") + ' style="width:24px;height:24px;margin-top:2px"><div class="grow"><div class="body" style="font-size:14.5px;color:var(--ink)">' + label + "</div>" + (sub ? '<div class="sub">' + h(sub) + "</div>" : "") + "</div></label>";
  }

  // ── Shoot mode ───────────────────────────────────────────────────────
  async function shoot(id) {
    if (!F().guard()) return;
    var t = T(), back = t.backBtn("#film/" + id, "Film");
    F().loading(back);
    var d = null, o = null, saved = false;
    try {
      await F().getMeta();
      d = await t.api("/api/studio-films/films/" + encodeURIComponent(id) + "/shoot");
      o = d.offline;
    } catch (e) {
      if (e.stale) throw e;
      // The server answered: that's its answer. No answer: the saved copy.
      if (e.status) return F().failed(back, e);
      o = lsGet(SHEET + id);
      saved = true;
      // A saved copy is good for 14 days.
      if (o && !(Date.now() - Date.parse(o.saved_at) <= SHEET_DAYS * 864e5)) { forget(id); o = null; }
      if (!o) return F().failed(back, { message: "No signal, and this phone has no saved shoot sheet for this film from the last 14 days. Open shoot mode once with a signal before you go." });
    }
    if (!saved) { if (o.closed) forget(id); else keepSheet(o); }
    var names = (d && d.names) || {};
    // Online, the board as written; the saved copy has only the lines with
    // no name, contact or place in them.
    var det = (d && d.details) || { schedule: o.schedule, must_have: o.must_have, frame_pair: o.frame_pair };
    // Online, a line the phone won't keep says so, so the director knows
    // before the signal goes.
    var later = function (x, kept) {
      if (x == null) return '<span class="sub">(details online only)</span>';
      return h(x) + (!saved && kept === null ? ' <span class="sub">(not saved on this phone)</span>' : "");
    };
    var ticks = lsGet(TICKS + id) || { must: {}, list: {}, ways: {} };
    var minors = o.people.some(function (p) { return p.is_minor; });
    var notCleared = o.people.filter(function (p) { return !p.cleared; }).length;

    var lights = o.people.map(function (p) {
      var cov = p.covers || {};
      var shows = p.is_minor ? "wide shots only: no face, name, jersey number, school or team logo" : (["face", "name", "jersey", "voice"].filter(function (k) { return cov[k]; }).join(", ") || "nothing identifying");
      var say = p.pulled ? "Consent pulled: not on camera." : p.cleared ? "Cleared. On camera: " + shows + "." : "Not cleared: shoot B-roll that doesn't show them, and call the producer.";
      var cls = p.pulled ? "pulled" : p.cleared ? "ok" : "stop";
      return '<div class="li" style="align-items:flex-start;min-height:0;padding:10px 4px"><span class="light ' + cls + '" aria-hidden="true"></span><div class="grow"><div class="name" style="font-size:15px">' + h(p.code) + (names[p.id] ? ' <span class="sub">' + h(names[p.id]) + "</span>" : "") + '</div><div class="sub">' + h([p.role, p.is_minor ? (p.texas_youth ? "minor · Texas youth" : "minor") : "", p.speaker ? "speaker" : ""].filter(Boolean).join(" · ")) + '</div><div class="body" style="font-size:13.5px;' + (p.cleared && !p.pulled ? "" : "color:var(--bad)") + '">' + h(say) + "</div></div></div>";
    }).join("");

    var times = (det.schedule || []).map(function (x) { return '<div class="row" style="padding:6px 0;border-top:1px solid #1E2C40"><b style="font:700 15px/1.3 var(--mono);min-width:56px">' + h(x.time || "") + '</b><div class="grow body" style="font-size:14.5px;color:var(--ink)">' + later(x.what) + "</div></div>"; }).join("");
    var must = (det.must_have || []).map(function (m, i) { return checkbox('data-must="' + i + '"', ticks.must[i], later(m, (o.must_have || [])[i])); }).join("");
    var fp = det.frame_pair || {};
    var cardHtml = (o.cards || []).map(function (c) {
      var open = c.title === "6. Minors on set" && minors;
      return '<details class="card tight"' + (open ? " open" : "") + '><summary class="name" style="cursor:pointer;font-size:15px;min-height:30px;display:flex;align-items:center">' + h(c.title.replace(/^\d+\.\s*/, "")) + '</summary><ul class="body" style="margin:4px 0 0;padding-left:18px;font-size:14px;display:flex;flex-direction:column;gap:6px">' +
        c.parts.map(function (p) { return "<li>" + (p.lead ? '<b style="color:var(--ink)">' + h(p.lead) + "</b> " : "") + h(p.text) + "</li>"; }).join("") + "</ul></details>";
    }).join("");
    var list = (o.checklist || []).map(function (x, i) { return checkbox('data-list="' + i + '"', ticks.list[i], h(x)); }).join("");
    var listDone = (o.checklist || []).filter(function (_, i) { return ticks.list[i]; }).length;

    t.show(null,
      '<div class="screen">' + back +
      '<div><p class="kicker">Shoot mode · ' + h(o.format_label + " · " + o.athlete_id) + '</p><h1 class="title sm">' + h(det.title || o.title || o.format_label) + "</h1>" +
      (o.shoot_date ? '<p class="lede" style="font-size:15px">Shoot day: ' + h(new Date(o.shoot_date + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })) + "</p>" : "") + "</div>" +
      (saved ? '<div class="card tight"><p class="body" style="font-size:13.5px;margin:0">No signal: this is the copy saved on this phone ' + h(T().ago(o.saved_at)) + ". It keeps times, codes and the lines with no name, contact or place in them; the rest shows when you're back online.</p></div>" : "") +
      (o.closed ? '<div class="card tight"><p class="body err" style="margin:0">This film is closed. Nothing more is shot for it.</p></div>' : "") +
      '<section class="sec"><div class="row"><h2 class="sec-h grow" style="margin:0">The cards</h2>' + (notCleared ? F().badge(notCleared + " not cleared", "bad") : F().badge("Everyone cleared", "ok")) + '</div><p class="sub" style="margin:0">No card, no shoot. Check before you roll.</p><div class="card tight" style="gap:0">' + (lights || '<p class="empty">No cards yet: nobody goes on camera.</p>') + "</div></section>" +
      (times ? '<section class="sec"><h2 class="sec-h">Call times</h2>' + (saved ? "" : '<p class="sub" style="margin:0">This phone keeps the times, not what they\'re for.</p>') + '<div class="card tight" style="gap:0">' + times + "</div></section>" : "") +
      (d && d.locations && d.locations.length ? '<section class="sec"><h2 class="sec-h">Where</h2><div class="card tight">' + d.locations.map(function (x) { return '<p class="body" style="font-size:14.5px;margin:0;color:var(--ink)">' + h(x) + "</p>"; }).join("") + "</div></section>" : "") +
      (must ? '<section class="sec"><h2 class="sec-h">The three must-haves</h2><div style="display:flex;flex-direction:column;gap:8px">' + must + "</div></section>" : "") +
      (fp.opening || fp.closing || (saved && (o.frame_pair || {}).opening === null) ? '<section class="sec"><h2 class="sec-h">The frame pair</h2><div class="card tight"><p class="body" style="font-size:14.5px;margin:0"><b style="color:var(--ink)">Opening:</b> ' + later(fp.opening, (o.frame_pair || {}).opening) + '</p><p class="body" style="font-size:14.5px;margin:0"><b style="color:var(--ink)">Closing:</b> ' + later(fp.closing, (o.frame_pair || {}).closing) + "</p></div></section>" : "") +
      (o.format === "same_drill" ? '<section class="sec"><h2 class="sec-h">The Same Drill</h2><a class="btn soft" href="#film-ghost/' + h(id) + '">Open the ghost frame</a><p class="sub" style="margin:0">The archive frame over the live camera, to match the angle, height and side. It never leaves this phone.</p></section>' : "") +
      '<section class="sec"><h2 class="sec-h">The kit for today</h2>' + (cardHtml || '<p class="empty">The kit\'s cards aren\'t here.</p>') + "</section>" +
      (list ? '<section class="sec"><div class="row"><h2 class="sec-h grow" style="margin:0">Shoot day: director</h2><span class="sub" id="listCount">' + listDone + " of " + o.checklist.length + "</span></div>" + '<div style="display:flex;flex-direction:column;gap:8px">' + list + "</div></section>" : "") +
      '<p class="sub" style="margin:0">Ticks stay on this phone. A copy of this sheet without names, contacts or places (times, codes and the plain lines) opens here for 14 days if the signal drops. Signing out removes it.' + (o.kit_version ? " Kit v" + h(o.kit_version) + "." : "") + "</p></div>");

    function save() { lsSet(TICKS + id, ticks); }
    document.querySelectorAll("[data-must]").forEach(function (c) { c.addEventListener("change", function () { ticks.must[c.dataset.must] = c.checked; save(); }); });
    document.querySelectorAll("[data-list]").forEach(function (c) {
      c.addEventListener("change", function () {
        ticks.list[c.dataset.list] = c.checked;
        save();
        var n = document.getElementById("listCount");
        if (n) n.textContent = (o.checklist || []).filter(function (_, i) { return ticks.list[i]; }).length + " of " + o.checklist.length;
      });
    });
  }

  // ── The ghost frame ──────────────────────────────────────────────────
  // The archive frame, see-through, over the live camera: match the angle,
  // the height, the side of the field and the lens feel. The frame is read
  // from this phone and shown here only; nothing is recorded or uploaded.
  async function ghost(id) {
    if (!F().guard()) return;
    var t = T(), back = t.backBtn("#film-shoot/" + id, "Shoot mode");
    var st = { stream: null, frame: null, opacity: 50, mirror: false, grid: true };
    var ticks = lsGet(TICKS + id) || { must: {}, list: {}, ways: {} };
    ticks.ways = ticks.ways || {};
    var ways = [["matched", "Matched: same angle, height, side and direction"], ["tighter", "One tighter"], ["wider", "One wider"]];
    t.show(null,
      '<div class="screen">' + back + '<div><p class="kicker">The Same Drill</p><h1 class="title sm">Ghost frame</h1></div>' +
      '<p class="lede" style="font-size:15px">Pick the archive frame from this phone, then line the live shot up under it. For Texas youth, match on what you can show: cleats, hands, a shadow or a back.</p>' +
      '<div class="ghostframe" id="gBox"><video id="gCam" playsinline muted autoplay></video><img id="gTest" alt="" hidden><img id="gFrame" alt="" hidden><div class="ghostframe-grid" id="gGrid"></div><p class="ghostframe-hint" id="gHint">Start the camera, then pick the archive frame.</p></div>' +
      '<div class="btn-row"><button type="button" class="btn small" id="gStart">Start the camera</button><label class="btn soft small" style="cursor:pointer">Archive frame<input type="file" id="gPick" accept="image/*" hidden></label></div>' +
      '<div class="field"><label class="label" for="gOpacity">See-through <small id="gOpVal">50%</small></label><input type="range" id="gOpacity" min="10" max="90" value="50" class="input" style="padding:0;min-height:36px"></div>' +
      '<div class="btn-row"><button type="button" class="btn ghost small" id="gMirror" aria-pressed="false">Flip the frame</button><button type="button" class="btn ghost small" id="gGridBtn" aria-pressed="true">Thirds and horizon</button></div>' +
      '<div id="gFallback" hidden><p class="body" style="font-size:14px">The camera didn\'t open here. Take a test shot instead and compare it under the frame:</p><label class="btn soft small" style="cursor:pointer">Take a test shot<input type="file" id="gShot" accept="image/*" capture="environment" hidden></label></div>' +
      '<section class="sec"><h2 class="sec-h">Shoot it three ways</h2><div style="display:flex;flex-direction:column;gap:8px">' + ways.map(function (w) { return checkbox('data-way="' + w[0] + '"', ticks.ways[w[0]], h(w[1])); }).join("") + "</div></section>" +
      '<p class="sub" style="margin:0">Nothing here is recorded or uploaded: the camera shows live, and the frame stays on this phone.</p></div>');

    var cam = document.getElementById("gCam"), frame = document.getElementById("gFrame"), test = document.getElementById("gTest"), hint = document.getElementById("gHint");
    var urls = [];
    // This screen's own flag: once it stops (left, or the app hidden while
    // asking), a camera that answers late is stopped at once.
    var live = true;
    var halt = function (stream) { if (stream) stream.getTracks().forEach(function (k) { k.stop(); }); };
    function stop() {
      live = false;
      halt(st.stream);
      st.stream = null;
      urls.forEach(function (u) { URL.revokeObjectURL(u); });
      urls = [];
      window.removeEventListener("hashchange", stop);
      document.removeEventListener("visibilitychange", hidden);
    }
    function hidden() { if (document.visibilityState === "hidden" && st.stream) { st.stream.getTracks().forEach(function (k) { k.stop(); }); st.stream = null; cam.srcObject = null; hint.hidden = false; hint.textContent = "The camera stopped when the app went to the background. Start it again."; } }
    window.addEventListener("hashchange", stop);
    document.addEventListener("visibilitychange", hidden);
    function look() {
      frame.style.opacity = String(st.opacity / 100);
      frame.style.transform = st.mirror ? "scaleX(-1)" : "";
      document.getElementById("gGrid").hidden = !st.grid;
      document.getElementById("gOpVal").textContent = st.opacity + "%";
    }
    look();
    document.getElementById("gStart").addEventListener("click", async function () {
      var btn = this;
      if (st.stream || btn.dataset.asking) return;
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("no camera");
        btn.dataset.asking = "1";
        var stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
        delete btn.dataset.asking;
        // Left, or hidden, while the phone asked: this answer is too late.
        if (!live || !document.body.contains(cam) || document.visibilityState === "hidden") return halt(stream);
        st.stream = stream;
        cam.srcObject = st.stream;
        test.hidden = true;
        hint.hidden = !!st.frame;
        hint.textContent = "Now pick the archive frame.";
        btn.textContent = "Camera on";
        btn.disabled = true;
      } catch (e) {
        delete btn.dataset.asking;
        if (!live) return;
        document.getElementById("gFallback").hidden = false;
        hint.textContent = "No live camera here: take a test shot below.";
      }
    });
    function pickInto(img, file) {
      if (!file) return;
      var u = URL.createObjectURL(file);
      urls.push(u);
      img.src = u;
      img.hidden = false;
    }
    document.getElementById("gPick").addEventListener("change", function () { st.frame = this.files && this.files[0]; pickInto(frame, st.frame); hint.hidden = true; look(); });
    document.getElementById("gShot").addEventListener("change", function () { pickInto(test, this.files && this.files[0]); hint.hidden = true; });
    document.getElementById("gOpacity").addEventListener("input", function () { st.opacity = Number(this.value); look(); });
    document.getElementById("gMirror").addEventListener("click", function () { st.mirror = !st.mirror; this.setAttribute("aria-pressed", String(st.mirror)); look(); });
    document.getElementById("gGridBtn").addEventListener("click", function () { st.grid = !st.grid; this.setAttribute("aria-pressed", String(st.grid)); look(); });
    document.querySelectorAll("[data-way]").forEach(function (c) { c.addEventListener("change", function () { ticks.ways[c.dataset.way] = c.checked; lsSet(TICKS + id, ticks); }); });
  }

  // ── The delivery check ───────────────────────────────────────────────
  // What the phone reads from an export (its size, shape and length, and its
  // name), checked by the server against the kit. The file stays here.
  var PATTERN = /^([A-Z]+)_([A-Z]+)_([A-Z0-9-]+)_([A-Z]+)_(\d+x\d+)_v(\d{2,3})_(\d{8})/i;
  function readFile(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var done = function (v) { URL.revokeObjectURL(url); resolve(v); };
      if (/^image\//.test(file.type) || /\.(png|jpe?g)$/i.test(file.name)) {
        var img = new Image();
        img.onload = function () { done({ width: img.naturalWidth, height: img.naturalHeight, duration_ms: null }); };
        img.onerror = function () { done(null); };
        img.src = url;
        return;
      }
      var v = document.createElement("video");
      var timer = setTimeout(function () { done(null); }, 15000);
      v.preload = "metadata";
      v.muted = true;
      v.playsInline = true;
      v.onloadedmetadata = function () { clearTimeout(timer); done({ width: v.videoWidth, height: v.videoHeight, duration_ms: isFinite(v.duration) ? Math.round(v.duration * 1000) : null }); };
      v.onerror = function () { clearTimeout(timer); done(null); };
      v.src = url;
    });
  }
  function nearestRatio(w, hgt) {
    var r = w / hgt, best = null, gap = 9;
    [["9x16", 9 / 16], ["4x5", 4 / 5], ["1x1", 1], ["16x9", 16 / 9]].forEach(function (x) { var g = Math.abs(Math.log(r / x[1])); if (g < gap) { gap = g; best = x[0]; } });
    return best;
  }
  async function check(id) {
    if (!F().guard()) return;
    var t = T(), back = t.backBtn("#film/" + id, "Film");
    F().loading(back);
    var d;
    try { await F().getMeta(); d = await t.api("/api/studio-films/films/" + encodeURIComponent(id)); } catch (e) { if (e.stale) throw e; return F().failed(back, e); }
    var f = d.film, tp = F().tpl(f.kit_slug);
    var st = { file: null, info: null, format: f.format, ratio: (tp.formats[f.format].ratios || ["9x16"])[0], result: null, reading: false };
    var codeToFormat = {};
    Object.keys(tp.formats).forEach(function (k) { codeToFormat[tp.formats[k].code] = k; });
    function kitName() { var day = today(); var fm = tp.formats[st.format]; return [tp.file_prefix || "SW", (tp.lanes[f.lane] || {}).code || "LANE", f.athlete_id, fm ? fm.code : "FMT", st.ratio, "v##", day].join("_"); }
    function draw() {
      var fm = tp.formats[st.format] || {};
      var res = st.result;
      var rows = res ? res.results.map(function (r) { var mark = r.ok === true ? '<span style="color:var(--ok)">✓</span>' : r.ok === false ? '<span style="color:var(--bad)">✗</span>' : '<span class="warnc">!</span>'; return '<div class="row" style="align-items:flex-start;padding:7px 0;border-top:1px solid #1E2C40"><b style="width:20px;flex:none" aria-hidden="true">' + mark + '</b><div class="grow body" style="font-size:14px;color:var(--ink)">' + h(r.text) + "</div></div>"; }).join("") : "";
      var recent = (d.delivery_checks || []).slice(0, 8).map(function (c) { return '<div class="row" style="padding:6px 0;border-top:1px solid #1E2C40"><div class="grow"><div class="name" style="font-size:14px;overflow-wrap:anywhere">' + h(c.file_name) + '</div><div class="sub">' + h(F().fmtLabel(f.kit_slug, c.format) + " " + F().ratio(c.ratio) + " · " + c.created_by + " · " + T().ago(c.created_at)) + "</div></div>" + (c.passed ? F().badge("Passed", "ok") : F().badge("Failed", "bad")) + "</div>"; }).join("");
      t.show(null,
        '<div class="screen">' + back + '<div><p class="kicker">' + h(f.title) + '</p><h1 class="title sm">Delivery check</h1></div>' +
        '<p class="lede" style="font-size:15px">Pick the export. This phone reads its length, size and shape; the file itself stays here.</p>' +
        '<div class="field"><label class="label" for="dFile">The export</label><input class="input" id="dFile" type="file" accept="video/mp4,video/quicktime,.m4v,image/png,image/jpeg"></div>' +
        (st.reading ? '<div class="spin"></div>' : "") +
        (st.file ? '<p class="body" style="font-size:14px">' + h(st.file.name) + (st.info ? " · " + st.info.width + "×" + st.info.height + (st.info.duration_ms != null ? " · " + tc(st.info.duration_ms) : "") : " · this phone couldn't read it: check it on the computer") + "</p>" : "") +
        '<div class="field"><label class="label" for="dFormat">Format</label><select class="input" id="dFormat">' + Object.keys(tp.formats).map(function (k) { return '<option value="' + k + '"' + (st.format === k ? " selected" : "") + ">" + h(tp.formats[k].label) + "</option>"; }).join("") + "</select></div>" +
        '<div class="field"><span class="label">Ratio</span><div class="seg" role="group" aria-label="Ratio">' + ["9x16", "4x5", "1x1", "16x9"].map(function (r) { return '<button type="button" data-r="' + r + '" aria-pressed="' + (st.ratio === r) + '">' + F().ratio(r) + "</button>"; }).join("") + "</div></div>" +
        '<article class="card tight"><div class="name" style="font-size:15px">The kit\'s way</div><p class="body" style="font-size:13.5px;margin:0">' + h(fm.label + ": " + fm.spec) + '.<br>Export 1080×1920 for 9:16 and 1080×1350 for 4:5. Check each app\'s current limits before delivery.<br>Name it <code style="overflow-wrap:anywhere">' + h(kitName()) + "</code>: the athlete ID, never a name.</p></article>" +
        '<button type="button" class="btn block" id="dCheck"' + (st.info ? "" : " disabled") + ">Check it</button>" +
        (res ? '<article class="card tight"><div class="row"><div class="name grow" style="font-size:15px">' + (res.passed ? "Ready to deliver" : "Not yet") + "</div>" + (res.passed ? F().badge("Passed", "ok") : F().badge("Failed", "bad")) + "</div>" + rows + "</article>" : "") +
        F().msgBox("dMsg") +
        (recent ? '<section class="sec"><h2 class="sec-h">Checked for this film</h2>' + recent + "</section>" : "") + "</div>");
      document.getElementById("dFile").addEventListener("change", async function () {
        st.file = this.files && this.files[0] || null;
        st.info = null;
        st.result = null;
        if (!st.file) return draw();
        st.reading = true;
        draw();
        st.info = await readFile(st.file);
        st.reading = false;
        var m = PATTERN.exec(st.file.name);
        if (m && codeToFormat[m[4].toUpperCase()]) st.format = codeToFormat[m[4].toUpperCase()];
        if (m && ["9x16", "4x5", "1x1", "16x9"].indexOf(m[5].toLowerCase()) >= 0) st.ratio = m[5].toLowerCase();
        else if (st.info) st.ratio = nearestRatio(st.info.width, st.info.height) || st.ratio;
        draw();
      });
      document.getElementById("dFormat").addEventListener("change", function () { st.format = this.value; st.result = null; draw(); });
      document.querySelectorAll("[data-r]").forEach(function (b) { b.addEventListener("click", function () { st.ratio = b.dataset.r; st.result = null; draw(); }); });
      document.getElementById("dCheck").addEventListener("click", async function () {
        var btn = this;
        btn.disabled = true;
        try {
          var r = await t.post("/api/studio-films/films/" + f.id + "/delivery-checks", { file_name: st.file.name, format: st.format, ratio: st.ratio, duration_ms: st.info.duration_ms, width: st.info.width, height: st.info.height, bytes: st.file.size });
          st.result = r.check;
          d.delivery_checks = [r.check].concat(d.delivery_checks || []);
          draw();
        } catch (e) { btn.disabled = false; F().say("dMsg", F().why(e), true); }
      });
    }
    draw();
  }

  // ── The graphics ─────────────────────────────────────────────────────
  // The proposed type system from the kit's Graphics column: Playfair Display
  // for headlines and quotes, Oswald (widely tracked caps) for title cards,
  // Courier Prime for letters. One accent: cream on dark frames. Real words
  // only, their spelling fixed and their meaning untouched; names only as far
  // as each release allows. Until Kyron and Coach Hooks approve it, every
  // graphic carries a PROPOSED band and none goes to review.
  var CREAM = "#EFE3C8", DARK = "#15161A", INK = "#1B1C1F";
  var SERIF = "'Playfair Display', Georgia, 'Times New Roman', serif";
  var CAPS = "Oswald, 'Arial Narrow', Impact, sans-serif";
  var TYPE = "'Courier Prime', 'Courier New', monospace";
  var FONTS = [
    ["Playfair Display", "/app/fonts/playfair-display-latin-400-normal.woff2", { style: "normal", weight: "400" }],
    ["Playfair Display", "/app/fonts/playfair-display-latin-400-italic.woff2", { style: "italic", weight: "400" }],
    ["Oswald", "/app/fonts/oswald-latin-500-normal.woff2", { style: "normal", weight: "500" }],
    ["Courier Prime", "/app/fonts/courier-prime-latin-400-normal.woff2", { style: "normal", weight: "400" }],
  ];
  var fontsReady = null;
  function loadFonts() {
    if (!fontsReady) {
      fontsReady = Promise.all(FONTS.map(function (x) {
        if (typeof FontFace === "undefined") return null;
        return new FontFace(x[0], "url(" + x[1] + ") format('woff2')", x[2]).load().then(function (ff) { document.fonts.add(ff); }, function () { return null; });
      }));
    }
    return fontsReady;
  }
  var SIZES = { "4x5": [1080, 1350], "9x16": [1080, 1920] };
  var TEMPLATES = {
    quote: { label: "Quote card", ratios: ["4x5", "9x16"], format: "quote_card", review: true, note: "Their own line as the headline, one word in italic, two or three more sentences from the same answer under it, and the credit." },
    words: { label: "In Their Own Words", ratios: ["4x5"], format: "own_words", review: true, note: "A carousel: the quote card, then letter slides in Courier Prime on paper, one idea each, their words. Five to seven slides." },
    title: { label: "Title card", ratios: ["9x16"], note: "One line in Oswald caps, cream, widely tracked, above the app's buttons. For the edit." },
    end: { label: "End card", ratios: ["9x16"], note: "Two seconds at the end: the Coached by Hooks mark only. This is a type stand-in until the mark file is added. For the edit." },
    year: { label: "Year labels", ratios: ["9x16"], note: "Small, in the top corner, always true: the year the clip was filmed. Transparent, to lay over the clip in the edit." },
  };
  var FIT = { quote_card: "quote", own_words: "words", same_drill: "year" };

  function cover(ctx, img, w, hgt) {
    var s = Math.max(w / img.naturalWidth, hgt / img.naturalHeight);
    var dw = img.naturalWidth * s, dh = img.naturalHeight * s;
    ctx.drawImage(img, (w - dw) / 2, (hgt - dh) / 2, dw, dh);
  }
  // Words laid into lines; each word keeps its own font (one may be italic).
  function layout(ctx, words, size, maxW, fontOf) {
    var lines = [], line = [], width = 0;
    ctx.font = fontOf(false, size);
    var space = ctx.measureText(" ").width;
    words.forEach(function (w) {
      ctx.font = fontOf(w.italic, size);
      var ww = ctx.measureText(w.text).width;
      if (line.length && width + space + ww > maxW) { lines.push({ words: line, width: width }); line = []; width = 0; }
      w.w = ww;
      width += (line.length ? space : 0) + ww;
      line.push(w);
    });
    if (line.length) lines.push({ words: line, width: width });
    return { lines: lines, space: space };
  }
  function drawWords(ctx, lay, x, y, size, lead, fontOf, align, maxW) {
    lay.lines.forEach(function (ln, i) {
      var cx = align === "right" ? x + maxW - ln.width : x;
      ln.words.forEach(function (w, j) {
        ctx.font = fontOf(w.italic, size);
        ctx.fillText(w.text, cx, y + i * size * lead);
        cx += w.w + (j < ln.words.length - 1 ? lay.space : 0);
      });
    });
  }
  // Tracked caps (the canvas's own letter spacing isn't everywhere yet).
  function trackedWidth(ctx, text, spacing) { var w = 0; for (var i = 0; i < text.length; i++) w += ctx.measureText(text[i]).width + (i < text.length - 1 ? spacing : 0); return w; }
  function drawTracked(ctx, text, x, y, spacing) { for (var i = 0; i < text.length; i++) { ctx.fillText(text[i], x, y); x += ctx.measureText(text[i]).width + spacing; } }
  function proposedBand(ctx, w) {
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.72)";
    ctx.fillRect(0, 0, w, 86);
    ctx.fillStyle = "#FFFFFF";
    ctx.font = "500 30px " + CAPS;
    ctx.textBaseline = "middle";
    var text = "PROPOSED · NOT APPROVED FOR POSTING";
    drawTracked(ctx, text, (w - trackedWidth(ctx, text, 4)) / 2, 44, 4);
    ctx.restore();
  }

  function quoteCard(ctx, W, H, g) {
    var tall = H / W > 1.5;
    if (g.photo) {
      cover(ctx, g.photo, W, H);
      var grad = ctx.createLinearGradient(0, H * 0.3, 0, H);
      grad.addColorStop(0, "rgba(12,12,14,0)");
      grad.addColorStop(0.55, "rgba(12,12,14,0.72)");
      grad.addColorStop(1, "rgba(12,12,14,0.9)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    } else {
      ctx.fillStyle = DARK;
      ctx.fillRect(0, 0, W, H);
    }
    var m = 96, maxW = W - m * 2 - (tall ? 70 : 0);
    var bottom = tall ? H * 0.78 : H - 104;
    var words = String(g.line || "").trim().split(/\s+/).filter(Boolean).map(function (x, i) { return { text: x, italic: i === g.italic }; });
    if (words.length) { words[0].text = "“" + words[0].text; words[words.length - 1].text += "”"; }
    var head = function (it, s) { return (it ? "italic " : "") + "400 " + s + "px " + SERIF; };
    var body = function (it, s) { return "400 " + s + "px " + SERIF; };
    var hs = 96, lay;
    do { lay = layout(ctx, words, hs, maxW, head); hs -= 4; } while (hs > 44 && lay.lines.length * (hs + 4) * 1.12 > H * (tall ? 0.36 : 0.42));
    hs += 4;
    var bw = String(g.more || "").trim().split(/\s+/).filter(Boolean).map(function (x) { return { text: x }; });
    var bs = 46, bl;
    do { bl = layout(ctx, bw, bs, maxW, body); bs -= 2; } while (bs > 30 && bl.lines.length * (bs + 2) * 1.4 > H * 0.24);
    bs += 2;
    var credit = String(g.credit || "").toUpperCase();
    ctx.font = "400 30px " + SERIF;
    var cw = trackedWidth(ctx, credit, 3);
    var headH = lay.lines.length * hs * 1.12, bodyH = bw.length ? bl.lines.length * bs * 1.4 + 34 : 0;
    var top = g.photo ? bottom - 70 - bodyH - headH : Math.max(tall ? H * 0.16 : 120, (bottom - 70 - bodyH - headH) / 2 + 40);
    ctx.fillStyle = CREAM;
    ctx.textBaseline = "alphabetic";
    drawWords(ctx, lay, m, top + hs, hs, 1.12, head, "left", maxW);
    if (bw.length) { ctx.globalAlpha = 0.86; drawWords(ctx, bl, m, top + headH + 34 + bs, bs, 1.4, body, "left", maxW); ctx.globalAlpha = 1; }
    ctx.font = "400 30px " + SERIF;
    if (credit) drawTracked(ctx, credit, m + maxW - cw, bottom, 3);
  }
  function letterSlide(ctx, W, H, text, page, total) {
    ctx.fillStyle = CREAM;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = INK;
    var m = 110, maxW = W - m * 2;
    var words = String(text || "").trim().split(/\s+/).filter(Boolean).map(function (x) { return { text: x }; });
    var font = function (it, s) { return "400 " + s + "px " + TYPE; };
    var s = 64, lay;
    do { lay = layout(ctx, words, s, maxW, font); s -= 2; } while (s > 34 && lay.lines.length * (s + 2) * 1.5 > H - 330);
    s += 2;
    drawWords(ctx, lay, m, 150 + s, s, 1.5, font, "left", maxW);
    ctx.font = "400 28px " + TYPE;
    var pg = page + " / " + total;
    ctx.fillText(pg, W - m - ctx.measureText(pg).width, H - 92);
    return lay.lines.length * s * 1.5 > H - 330;
  }
  function titleCard(ctx, W, H, g) {
    if (g.photo) {
      cover(ctx, g.photo, W, H);
      ctx.fillStyle = "rgba(34,24,12,0.38)";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      ctx.fillRect(0, 0, W, H);
    } else {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
    }
    var text = String(g.line || "").trim().toUpperCase();
    var left = W * 0.1, maxW = W * 0.76, s = 120, sp;
    do { ctx.font = "500 " + s + "px " + CAPS; sp = s * 0.3; s -= 4; } while (s > 44 && trackedWidth(ctx, text, sp) > maxW);
    s += 4;
    ctx.font = "500 " + s + "px " + CAPS;
    sp = s * 0.3;
    ctx.fillStyle = CREAM;
    ctx.textBaseline = "middle";
    var tw = trackedWidth(ctx, text, sp);
    if (tw <= maxW) drawTracked(ctx, text, left + (maxW - tw) / 2, H * 0.45, sp);
    else {
      // Two lines, split at the space nearest the middle.
      var mid = text.length / 2, cut = -1;
      for (var i = 0; i < text.length; i++) if (text[i] === " " && (cut < 0 || Math.abs(i - mid) < Math.abs(cut - mid))) cut = i;
      var a = cut > 0 ? text.slice(0, cut) : text, b = cut > 0 ? text.slice(cut + 1) : "";
      drawTracked(ctx, a, left + Math.max(0, (maxW - trackedWidth(ctx, a, sp)) / 2), H * 0.45 - s * 0.62, sp);
      drawTracked(ctx, b, left + Math.max(0, (maxW - trackedWidth(ctx, b, sp)) / 2), H * 0.45 + s * 0.62, sp);
    }
    return tw > maxW * 2;
  }
  function endCard(ctx, W, H) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = CREAM;
    ctx.font = "500 64px " + CAPS;
    ctx.textBaseline = "middle";
    var text = "COACHED BY HOOKS", sp = 18;
    drawTracked(ctx, text, (W - trackedWidth(ctx, text, sp)) / 2, H * 0.45, sp);
  }
  function yearLabel(ctx, W, H, year) {
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = 10;
    ctx.fillStyle = CREAM;
    ctx.font = "500 52px " + CAPS;
    ctx.textBaseline = "top";
    drawTracked(ctx, String(year), 84, 150, 6);
    ctx.restore();
  }

  async function graphics(id) {
    if (!F().guard()) return;
    var t = T(), back = t.backBtn("#film/" + id, "Film");
    F().loading(back);
    var d, meta;
    // The switch is read fresh: an earlier answer may be from before Kyron changed it.
    try { meta = await F().getMeta(true); d = await t.api("/api/studio-films/films/" + encodeURIComponent(id)); } catch (e) { if (e.stale) throw e; return F().failed(back, e); }
    if (d.film.pulled_at || d.film.archived_at) return F().failed(back, { message: "This film is closed (consent pulled or archived): nothing more is made for it." });
    await loadFonts();
    var f = d.film, tp = F().tpl(f.kit_slug);
    var on = function (tool) { return (meta.tools || []).some(function (x) { return x.tool === tool && x.is_on; }); };
    var approved = on("graphics_system"), copiesOn = on("review_copies");
    var people = d.people.filter(function (p) { return p.cleared_at && !p.consent_pulled_at; });
    var banned = meta.banned ? [new RegExp(meta.banned.words, "gi"), new RegExp(meta.banned.phrases, "gi")] : [];
    var draft = ssGet(DRAFT + id) || {};
    if (draft.at && !(Date.now() - draft.at < 864e5)) { ssDel(DRAFT + id); draft = {}; }
    var g = {
      tpl: draft.tpl && TEMPLATES[draft.tpl] ? draft.tpl : FIT[f.format] || "title",
      ratio: draft.ratio || "4x5", line: draft.line || "", italic: draft.italic == null ? -1 : draft.italic, more: draft.more || "",
      letters: draft.letters || "", title: draft.title || "", then: draft.then || "", now: draft.now || String(new Date().getFullYear()),
      speaker: draft.speaker || ((people.find(function (p) { return p.speaker; }) || people[0] || {}).id || null), creditAs: draft.creditAs || "role",
      people: [], photo: null, photoOk: false, yearsTrue: false,
    };
    g.people = g.speaker ? [g.speaker] : [];
    function keepDraft() { ssSet(DRAFT + id, { at: Date.now(), tpl: g.tpl, ratio: g.ratio, line: g.line, italic: g.italic, more: g.more, letters: g.letters, title: g.title, then: g.then, now: g.now, speaker: g.speaker, creditAs: g.creditAs }); }
    var ROLE = { athlete: "athlete", parent: "parent", guardian: "parent", coach: "coach", other: "family" };
    // A graphic names someone only as far as their release goes: an adult,
    // cleared, consent standing, the release covering their name and listing
    // this format (the server checks the same before anything is saved).
    function mayNameOn(p, format) {
      return !!(p && p.id && !p.is_minor && !p.texas_youth && p.cleared_at && !p.consent_pulled_at && p.covers && p.covers.name === true && Array.isArray(p.covers.formats) && p.covers.formats.indexOf(format) >= 0);
    }
    function credit() {
      var p = d.people.find(function (x) { return x.id === g.speaker; });
      if (!p) return "Coached by Hooks";
      var named = mayNameOn(p, TEMPLATES[g.tpl].format || f.format);
      if (named && g.creditAs === "full") return p.name + " · Coached by Hooks";
      if (named && g.creditAs === "first") return p.name.split(/\s+/)[0] + " · Coached by Hooks";
      return "A Coached by Hooks " + (ROLE[p.role] || "athlete");
    }
    // What the words may not carry: a name a release doesn't cover, or a
    // banned word. A minor's name, even a two-letter word of it ("Bo"); a
    // two-letter everyday word ("He" in Bo He) only with a capital mid-sentence.
    var everyday = {};
    (meta.everyday_2 || []).forEach(function (w) { everyday[w] = true; });
    function capitalMid(raw, w) {
      var re = /[\p{L}\p{M}]+/gu, m;
      while ((m = re.exec(raw))) {
        if (m[0].toLowerCase() !== w || m[0][0] === m[0][0].toLowerCase()) continue;
        var before = raw.slice(0, m.index), gap = /\s*$/.exec(before)[0], prev = before.slice(0, before.length - gap.length);
        if (!prev || gap.indexOf("\n") >= 0 || /[.!?:;"“(\[—–-]$/.test(prev)) continue;
        return true;
      }
      return false;
    }
    function problems(texts) {
      var out = [];
      var all = texts.join("\n");
      d.people.forEach(function (p) {
        var minor = !!(p.is_minor || p.texas_youth);
        var mayName = !minor && p.covers && p.covers.name;
        var hay = " " + all.toLowerCase().replace(/[^\p{L}\p{M}]+/gu, " ") + " ";
        var hit = String(p.name || "").toLowerCase().split(/[^\p{L}\p{M}]+/u).filter(function (w) {
          var len = Array.from(w).length;
          if (minor && len === 2 && everyday[w]) return capitalMid(all, w);
          return len >= (minor ? 2 : 3) && hay.indexOf(" " + w + " ") >= 0;
        }).length;
        if (hit && !mayName) out.push("The words name " + p.person_code + ", whose card doesn't cover their name. Use the credit line the release allows.");
      });
      banned.forEach(function (re) { re.lastIndex = 0; if (re.test(all)) out.push("A word on the TOJ banned list is in the words. Say the concrete thing instead."); });
      return out;
    }
    function slidesOf() {
      if (g.tpl === "quote") return [{ kind: "quote", ratio: g.ratio }];
      if (g.tpl === "words") {
        var parts = g.letters.split(/\n\s*\n/).map(function (x) { return x.trim(); }).filter(Boolean);
        return [{ kind: "quote", ratio: "4x5" }].concat(parts.map(function (p, i) { return { kind: "letter", ratio: "4x5", text: p, page: i + 2, total: parts.length + 1 }; }));
      }
      if (g.tpl === "title") return [{ kind: "title", ratio: "9x16" }];
      if (g.tpl === "end") return [{ kind: "end", ratio: "9x16" }];
      return [g.then, g.now].filter(function (y) { return /^\d{4}$/.test(y); }).map(function (y) { return { kind: "year", ratio: "9x16", year: y }; });
    }
    function render(slide, canvas) {
      var sz = SIZES[slide.ratio];
      canvas.width = sz[0];
      canvas.height = sz[1];
      var ctx = canvas.getContext("2d");
      var long = false;
      if (slide.kind === "quote") quoteCard(ctx, sz[0], sz[1], { photo: g.photo, line: g.line, italic: g.italic, more: g.more, credit: credit() });
      else if (slide.kind === "letter") long = letterSlide(ctx, sz[0], sz[1], slide.text, slide.page, slide.total);
      else if (slide.kind === "title") long = titleCard(ctx, sz[0], sz[1], { photo: g.photo, line: g.title });
      else if (slide.kind === "end") endCard(ctx, sz[0], sz[1]);
      else yearLabel(ctx, sz[0], sz[1], slide.year);
      if (!approved) proposedBand(ctx, sz[0]);
      return long;
    }
    function nextVersion(format, ratio) { return d.cuts.filter(function (c) { return c.format === format && c.ratio === ratio; }).reduce(function (m, c) { return Math.max(m, c.version); }, 0) + 1; }
    function setName(format, ratio, v) { var day = today(); var fm = tp.formats[format]; return [tp.file_prefix || "SW", (tp.lanes[f.lane] || {}).code || "LANE", f.athlete_id, fm ? fm.code : "FMT", ratio, "v" + String(v).padStart(2, "0"), day].join("_"); }

    function draw() {
      var tm = TEMPLATES[g.tpl];
      var speakerCard = d.people.find(function (x) { return x.id === g.speaker; }) || {};
      var mayName = mayNameOn(speakerCard, TEMPLATES[g.tpl].format || f.format);
      var words = String(g.line || "").trim().split(/\s+/).filter(Boolean);
      var form = "";
      if (g.tpl === "quote" || g.tpl === "words") {
        form += '<div class="field"><label class="label" for="gLine">Their own line <small>(word for word, from the transcript)</small></label><textarea class="textarea" id="gLine" maxlength="200" style="min-height:70px">' + h(g.line) + "</textarea></div>" +
          (words.length ? '<div class="field"><span class="label">The word in italic</span><div class="chips" style="flex-wrap:wrap;margin:0;padding:0">' + words.map(function (w, i) { return '<button type="button" class="chip" data-it="' + i + '" aria-pressed="' + (g.italic === i) + '">' + h(w.replace(/[“”"]/g, "")) + "</button>"; }).join("") + '<button type="button" class="chip" data-it="-1" aria-pressed="' + (g.italic === -1) + '">None</button></div></div>' : "") +
          '<div class="field"><label class="label" for="gMore">Two or three more sentences <small>(from the same answer)</small></label><textarea class="textarea" id="gMore" maxlength="400" style="min-height:80px">' + h(g.more) + "</textarea></div>" +
          '<div class="field"><label class="label" for="gSpeaker">Whose words</label><select class="input" id="gSpeaker">' + people.map(function (p) { return '<option value="' + h(p.id) + '"' + (g.speaker === p.id ? " selected" : "") + ">" + h(p.person_code + " · " + p.name) + "</option>"; }).join("") + "</select></div>" +
          '<div class="field"><span class="label">The credit <small>(only as far as the release allows)</small></span><div class="seg" role="group" aria-label="Credit">' +
          (mayName ? '<button type="button" data-credit="full" aria-pressed="' + (g.creditAs === "full") + '">Full name</button><button type="button" data-credit="first" aria-pressed="' + (g.creditAs === "first") + '">First name</button>' : "") +
          '<button type="button" data-credit="role" aria-pressed="' + (!mayName || g.creditAs === "role") + '">No name</button></div><span class="sub">' + h(credit()) + (mayName ? "" : " (the card doesn't cover a name)") + "</span></div>";
      }
      if (g.tpl === "words") form += '<div class="field"><label class="label" for="gLetters">The letter <small>(one idea per slide: a blank line starts the next)</small></label><textarea class="textarea" id="gLetters" maxlength="3000" style="min-height:160px;font-family:var(--mono)">' + h(g.letters) + "</textarea></div>";
      if (g.tpl === "title") form += '<div class="field"><label class="label" for="gTitle">The line</label><input class="input" id="gTitle" maxlength="60" value="' + h(g.title) + '"></div>';
      if (g.tpl === "year") form += '<div class="row" style="gap:10px"><div class="field grow"><label class="label" for="gThen">Then</label><input class="input" id="gThen" inputmode="numeric" maxlength="4" placeholder="2017" value="' + h(g.then) + '"></div><div class="field grow"><label class="label" for="gNow">Now</label><input class="input" id="gNow" inputmode="numeric" maxlength="4" value="' + h(g.now) + '"></div></div>' + checkbox('id="gTrue"', g.yearsTrue, "These are the years the clips were filmed", "The kit: year labels are always true.");
      if (g.tpl === "quote" || g.tpl === "title") {
        form += '<div class="field"><span class="label">A photo <small>(optional: a real, cleared photo from the shoot)</small></span><div class="btn-row"><label class="btn soft small" style="cursor:pointer">' + (g.photo ? "Change the photo" : "Pick a photo") + '<input type="file" id="gPhoto" accept="image/png,image/jpeg" hidden></label>' + (g.photo ? '<button type="button" class="btn ghost small" id="gNoPhoto">No photo</button>' : "") + "</div>" +
          (g.photo ? checkbox('id="gPhotoOk"', g.photoOk, "Everyone in it is ticked below, and it shows only what their cards allow", "Minors: wide, no face, name, jersey number, school or logo.") : "") + "</div>";
      }
      if (tm.review) {
        form += '<div class="field"><span class="label">Who\'s in it <small>(the clip log)</small></span><div style="display:flex;flex-direction:column;gap:8px">' + people.map(function (p) { return checkbox('data-gp="' + h(p.id) + '"', g.people.indexOf(p.id) >= 0, h(p.person_code + " · " + p.name), p.speaker ? "Speaker" : "On camera"); }).join("") + "</div></div>";
      }
      var slides = slidesOf();
      var warnings = [];
      if (g.tpl === "words" && (slides.length < 5 || slides.length > 7)) warnings.push("The kit's carousel is 5 to 7 slides; this one is " + slides.length + ".");
      t.show(null,
        '<div class="screen">' + back + '<div><p class="kicker">' + h(f.title) + '</p><h1 class="title sm">Graphics</h1></div>' +
        (approved ? "" : '<div class="card tight"><p class="body" style="font-size:13.5px;margin:0">The graphics system is <b style="color:var(--ink)">proposed</b>: everything here carries a PROPOSED band, and nothing goes to review, until Kyron and Coach Hooks approve it (Tool approvals).</p></div>') +
        '<div class="chips">' + Object.keys(TEMPLATES).map(function (k) { return '<button type="button" class="chip" data-tpl="' + k + '" aria-pressed="' + (g.tpl === k) + '">' + h(TEMPLATES[k].label) + "</button>"; }).join("") + "</div>" +
        '<p class="body" style="font-size:14px;margin:0">' + h(tm.note) + "</p>" +
        (tm.ratios.length > 1 ? '<div class="seg" role="group" aria-label="Ratio">' + tm.ratios.map(function (r) { return '<button type="button" data-gr="' + r + '" aria-pressed="' + (g.ratio === r) + '">' + F().ratio(r) + "</button>"; }).join("") + "</div>" : "") +
        '<div class="chips" id="gSlides" style="gap:10px;align-items:flex-start"></div>' +
        form +
        '<div id="gIssues"></div>' + F().msgBox("gMsg") + "</div>" +
        '<div class="dock"><div class="dock-inner"><div class="btn-row" style="justify-content:center"><button type="button" class="btn soft small" id="gSave">Save the PNGs</button>' +
        (tm.review ? '<button type="button" class="btn small" id="gSend"' + (approved && copiesOn ? "" : " disabled") + ">Send for review</button>" : "") + "</div>" +
        '<span class="note">' + (tm.review ? (approved ? (copiesOn ? "The speaker approves these exact slides on their link, like a cut." : "Review copies are off (Tool approvals).") : "Review waits for the graphics system's approval.") : "For the edit: lay it in the timeline.") + "</span></div></div>");
      paint();
      var issues = problems([g.line, g.more, g.letters, g.title, credit()]).concat(warnings);
      if (g.tpl === "year" && (!/^\d{4}$/.test(g.then) || Number(g.then) < 1950 || Number(g.then) > Number(g.now) || Number(g.now) > new Date().getFullYear())) issues.push("Write both years as four digits, then before now, and now no later than this year.");
      document.getElementById("gIssues").innerHTML = issues.map(function (x) { return '<p class="body warnc" style="font-size:13.5px;margin:0">' + h(x) + "</p>"; }).join("");
      wire();
    }
    var canvases = [];
    function paint() {
      var box = document.getElementById("gSlides");
      box.innerHTML = "";
      canvases = slidesOf().map(function (s) {
        var c = document.createElement("canvas");
        c.className = "gslide";
        c.style.width = s.ratio === "9x16" ? "180px" : "250px";
        c.setAttribute("role", "img");
        c.setAttribute("aria-label", TEMPLATES[g.tpl].label + (s.page ? ", slide " + s.page : ""));
        render(s, c);
        box.appendChild(c);
        return { slide: s, canvas: c };
      });
      if (!canvases.length) box.innerHTML = '<p class="empty">Write the years to see the labels.</p>';
    }
    // The PNGs, each marked as made with the graphics system (a tEXt chunk the
    // worker reads), so a set can't come back as an "upload" while it's off.
    function blobs() { return Promise.all(canvases.map(function (x) { return new Promise(function (r) { x.canvas.toBlob(function (b) { r(b); }, "image/png"); }); })).then(function (list) { return Promise.all(list.map(markPng)); }); }
    // Before anything is saved or sent: the switch read again, and the words
    // and the credit checked by the server's rules. null when it can go.
    // The words as they are now, to check and then draw from: what's
    // exported is exactly what the server checked.
    var asked = null;
    function wordsNow() { return [g.line, g.more, g.letters, g.title].map(function (x) { return String(x || ""); }); }
    async function cleared(forReview) {
      var was = approved;
      var texts = wordsNow();
      meta = await F().getMeta(true);
      approved = on("graphics_system"); copiesOn = on("review_copies");
      if (approved !== was) { draw(); return approved ? "The graphics system was just approved: look again, then tap again." : "The graphics system was just switched off: this now carries the PROPOSED band. Look again, then tap again."; }
      var tm = TEMPLATES[g.tpl];
      var same = asked && asked.texts.join("\u0000") === texts.join("\u0000");
      var r = await T().post("/api/studio-films/films/" + encodeURIComponent(f.id) + "/graphics/check", { texts: texts, speaker_id: g.speaker, credit: g.creditAs, format: tm.format || f.format, for_review: !!forReview, names_ok: same ? asked.words : [] });
      if (r.problems && r.problems.length) return r.problems[0];
      if (r.asks && r.asks.length) {
        asked = { texts: texts, words: (same ? asked.words : []).concat(r.asks) };
        var tags = r.asks.filter(function (w) { return /^[#@]/.test(w); }), plain = r.asks.filter(function (w) { return !/^[#@]/.test(w); });
        var q = function (l) { return "\u201c" + l.join("\u201d, \u201c") + "\u201d"; };
        return (plain.length ? q(plain) + " is also a name on a card that this graphic can't carry. " : "") + (tags.length ? q(tags) + " has a name on a card run into it. " : "") + "If it isn't a name here, tap again.";
      }
      if (r.credit && r.credit !== credit()) { g.creditAs = "role"; keepDraft(); draw(); return "The credit can only be what the release allows: it now reads \u201c" + r.credit + "\u201d. Look again, then tap again."; }
      // Typed over while it was checked: check again.
      if (wordsNow().join("\u0000") !== texts.join("\u0000")) return "The words changed while they were checked. Tap again.";
      // Draw from the checked words now, so the files show exactly them.
      paint();
      return null;
    }
    function wire() {
      var val = function (x) { var el = document.getElementById(x); return el ? el.value : null; };
      var keep = function () {
        if (val("gLine") !== null) g.line = val("gLine");
        if (val("gMore") !== null) g.more = val("gMore");
        if (val("gLetters") !== null) g.letters = val("gLetters");
        if (val("gTitle") !== null) g.title = val("gTitle");
        if (val("gThen") !== null) g.then = val("gThen").replace(/\D/g, "");
        if (val("gNow") !== null) g.now = val("gNow").replace(/\D/g, "");
        keepDraft();
      };
      var later = null;
      ["gLine", "gMore", "gLetters", "gTitle", "gThen", "gNow"].forEach(function (x) {
        var el = document.getElementById(x);
        if (el) el.addEventListener("input", function () {
          keep();
          clearTimeout(later);
          // Repaint after a pause; redraw the form only when the words (and so the italic choices) change.
          later = setTimeout(function () { if (x === "gLine") { var at = el.selectionStart; draw(); var again = document.getElementById("gLine"); again.focus(); again.setSelectionRange(at, at); } else { paint(); } }, 350);
        });
      });
      document.querySelectorAll("[data-tpl]").forEach(function (b) { b.addEventListener("click", function () { keep(); g.tpl = b.dataset.tpl; if (TEMPLATES[g.tpl].ratios.indexOf(g.ratio) < 0) g.ratio = TEMPLATES[g.tpl].ratios[0]; keepDraft(); draw(); }); });
      document.querySelectorAll("[data-gr]").forEach(function (b) { b.addEventListener("click", function () { keep(); g.ratio = b.dataset.gr; keepDraft(); draw(); }); });
      document.querySelectorAll("[data-it]").forEach(function (b) { b.addEventListener("click", function () { keep(); g.italic = Number(b.dataset.it); keepDraft(); draw(); }); });
      document.querySelectorAll("[data-credit]").forEach(function (b) { b.addEventListener("click", function () { keep(); g.creditAs = b.dataset.credit; keepDraft(); draw(); }); });
      document.querySelectorAll("[data-gp]").forEach(function (c) { c.addEventListener("change", function () { var k = c.dataset.gp; g.people = c.checked ? g.people.concat([k]) : g.people.filter(function (x) { return x !== k; }); }); });
      var sp = document.getElementById("gSpeaker");
      if (sp) sp.addEventListener("change", function () { keep(); g.speaker = this.value; if (g.people.indexOf(g.speaker) < 0) g.people.push(g.speaker); g.creditAs = "role"; keepDraft(); draw(); });
      var ph = document.getElementById("gPhoto");
      if (ph) ph.addEventListener("change", function () {
        var file = this.files && this.files[0];
        if (!file) return;
        keep();
        var img = new Image();
        var u = URL.createObjectURL(file);
        img.onload = function () { g.photo = img; g.photoOk = false; draw(); setTimeout(function () { URL.revokeObjectURL(u); }, 1000); };
        img.onerror = function () { URL.revokeObjectURL(u); F().say("gMsg", "That photo didn't open here.", true); };
        img.src = u;
      });
      var np = document.getElementById("gNoPhoto");
      if (np) np.addEventListener("click", function () { keep(); g.photo = null; g.photoOk = false; draw(); });
      var pok = document.getElementById("gPhotoOk");
      if (pok) pok.addEventListener("change", function () { g.photoOk = pok.checked; });
      var yt = document.getElementById("gTrue");
      if (yt) yt.addEventListener("change", function () { g.yearsTrue = yt.checked; });
      document.getElementById("gSave").addEventListener("click", async function () {
        keep();
        var why = ready(false);
        if (why) return F().say("gMsg", why, true);
        try { why = await cleared(false); } catch (e) { return F().say("gMsg", F().why(e), true); }
        if (why) return F().say("gMsg", why, true);
        var list = await blobs();
        var base = TEMPLATES[g.tpl].format ? setName(TEMPLATES[g.tpl].format, g.ratio, nextVersion(TEMPLATES[g.tpl].format, g.ratio)) : f.athlete_id + "_" + g.tpl.toUpperCase() + "_9x16";
        list.forEach(function (b, i) {
          var u = URL.createObjectURL(b);
          var a = document.createElement("a");
          a.href = u;
          a.download = base + (list.length > 1 ? "_" + (canvases[i].slide.year || i + 1) : "") + ".png";
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(function () { URL.revokeObjectURL(u); }, 4000);
        });
        T().toast(approved ? "Saved." : "Saved, marked PROPOSED.");
      });
      var send = document.getElementById("gSend");
      if (send) send.addEventListener("click", async function () {
        keep();
        var why = ready(true);
        if (why) return F().say("gMsg", why, true);
        var tm = TEMPLATES[g.tpl], v = nextVersion(tm.format, g.ratio);
        send.disabled = true;
        F().busy(1);
        try {
          why = await cleared(true);
          if (why) { send.disabled = false; F().busy(-1); return F().say("gMsg", why, true); }
          var list = await blobs();
          await F().uploadSet(f.id, { format: tm.format, ratio: g.ratio, version: v, file_name: setName(tm.format, g.ratio, v), people: g.people, made_with: "graphics" }, list, function (n, pr) { send.textContent = "Sending " + n + " of " + list.length + " · " + Math.round(pr * 100) + "%"; });
          ssDel(DRAFT + id);
          T().toast("Sent: the marked copies are on their way. Then send the speaker their link.");
          T().go("#film/" + f.id);
        } catch (e) { send.disabled = false; send.textContent = "Send for review"; F().say("gMsg", F().why(e), true); } finally { F().busy(-1); }
      });
    }
    // Why it can't go yet, or null.
    function ready(forReview) {
      if (!canvases.length) return "Nothing to save yet.";
      if ((g.tpl === "quote" || g.tpl === "words") && !String(g.line).trim()) return "Write their line first: word for word, from the transcript.";
      if (g.tpl === "words" && canvases.length < 2) return "Write the letter: a blank line starts each slide.";
      if (g.tpl === "title" && !String(g.title).trim()) return "Write the line first.";
      if (g.tpl === "year" && !g.yearsTrue) return "Tick that these are the years the clips were filmed.";
      if (g.photo && !g.photoOk) return "Tick that everyone in the photo is listed and it shows only what their cards allow.";
      var issues = problems([g.line, g.more, g.letters, g.title, credit()]);
      if (issues.length) return issues[0];
      if (forReview && g.speaker && g.people.indexOf(g.speaker) < 0) return "Tick the speaker in Who's in it: they approve their own words.";
      return null;
    }
    draw();
  }

  // Everything this phone keeps for films (shoot sheets, ticks, graphics
  // drafts), gone at sign-out.
  function forgetAll() {
    ["toj.shoot.", "toj.graphics."].forEach(function (p) { lsKeys(p).forEach(lsDel); });
    try { for (var i = sessionStorage.length - 1; i >= 0; i--) { var k = sessionStorage.key(i); if (k && (k.indexOf("toj.shoot.") === 0 || k.indexOf("toj.graphics.") === 0)) sessionStorage.removeItem(k); } } catch (e) { /* blocked */ }
  }
  window.TOJFilmCraft = { forgetAll: forgetAll };
  window.TOJScreens = Object.assign(window.TOJScreens || {}, { "film-shoot": shoot, "film-ghost": ghost, "film-check": check, "film-graphics": graphics });
})();
