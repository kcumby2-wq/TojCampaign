// The chat room screen as shipped (public/app/chat.js), run in a vm with a
// small fake page against the real chat routes and an in-memory Supabase.
// It checks the room's polling: nothing someone else sends is skipped, your
// own sends included. Made-up people only.
//
//   node --test tests/chat-client.test.js

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");

process.env.ADMIN_EMAILS = "kyron@example.com";
const { fakeSupabase } = require("./helpers/fake-supabase");
const { setSupabase } = require("../utils/supabase");
const C = require("../utils/chat");
const P = require("../utils/push");

const SRC = fs.readFileSync(path.join(__dirname, "..", "public", "app", "chat.js"), "utf8");
let server, base;

function statsRpc(tables, { p_person, p_rooms }) {
  const msgs = tables.chat_messages || [];
  const reads = tables.chat_reads || [];
  return {
    data: (tables.chat_rooms || []).filter((r) => p_rooms.includes(r.id)).map((r) => {
      const inRoom = msgs.filter((m) => m.room_id === r.id).sort((a, b) => a.id - b.id);
      const read = reads.find((x) => x.person_id === p_person && x.room_id === r.id);
      const upto = read ? read.last_read_id || 0 : 0;
      const last = inRoom[inRoom.length - 1];
      return { room_id: r.id, unread: inRoom.filter((m) => !m.removed_at && m.author_id !== p_person && m.id > upto).length, last_id: last ? last.id : null, last_at: last ? last.created_at : null, last_author: last ? last.author_id : null, last_body: last && last.body ? last.body.slice(0, 140) : null, last_removed: !!(last && last.removed_at) };
    }),
    error: null,
  };
}

before(async () => {
  const db = fakeSupabase(
    {
      users: [{ email: "kyron@example.com", hash: "x", role: "admin" }],
      team_members: [{ email: "wes@example.com", name: "Wes West", role: "member", tools: ["gfs"], regions: ["west"], status: "active" }],
    },
    { unique: { chat_people: ["email"], chat_rooms: ["slug"] }, rpc: { chat_room_stats: statsRpc }, serial: ["chat_messages"] }
  );
  setSupabase(db);
  P.setSender(async () => ({}));
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "t", resave: false, saveUninitialized: false }));
  app.post("/test-login", (req, res) => { req.session.userEmail = req.body.email; req.session.userRole = req.body.role || "creator"; req.session.save(() => res.json({ ok: true })); });
  app.use("/api/chat", require("../routes/chat"));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server && server.close(); P.setSender(null); });

async function as(email, role) {
  let cookie = "";
  const call = async (p, { method = "GET", body } = {}) => {
    const r = await fetch(base + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : null };
  };
  call.cookie = () => cookie;
  await call("/test-login", { method: "POST", body: { email, role } });
  return call;
}

// A tiny page: elements by id, the TOJ helpers the screen uses, and timers
// run by hand (tick), so each poll happens when the test says.
function fakeEl() {
  const listeners = {};
  return {
    hidden: false, value: "", disabled: false, style: {}, dataset: {}, isConnected: true, textContent: "",
    scrollHeight: 40, offsetHeight: 60, selectionStart: 0, selectionEnd: 0, _html: "",
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); },
    set outerHTML(v) {},
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    removeEventListener() {},
    fire(ev) { for (const fn of listeners[ev] || []) fn({ target: this, currentTarget: this, preventDefault() {} }); },
    setAttribute() {}, querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
    focus() {}, scrollIntoView() {}, remove() {}, appendChild() {},
  };
}
function loadRoom(cookie, hash) {
  let els = {};
  const appEl = fakeEl();
  const el = (id) => (id === "app" ? appEl : (els[id] = els[id] || fakeEl()));
  const timers = [];
  const location = { hash, replace(x) { this.hash = x; } };
  const h = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  async function api(p, opts) {
    const o = opts || {};
    const r = await fetch(base + p, { method: o.method || "GET", headers: Object.assign({ cookie: cookie() }, o.headers || {}), body: o.body });
    const text = await r.text();
    const d = text ? JSON.parse(text) : {};
    if (!r.ok) { const e = new Error(d.error); e.data = d; throw e; }
    return d;
  }
  const TOJ = {
    api, h, toast() {}, backBtn: () => "", I: { plus: "", chev: "", check: "" },
    post: (p, body, method) => api(p, { method: method || "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }),
    show(tab, html) { els = {}; appEl.innerHTML = html; },
    go(x) { location.hash = x; }, later(fn) { timers.push(fn); },
    atLeast: () => true, isOwner: () => false, hasTool: () => true, ago: () => "",
    state: { me: { authenticated: true, team: { role: "member" } } },
  };
  const window = { TOJ, TOJScreens: {}, innerHeight: 800, scrollY: 0, scrollTo() {}, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true }) };
  const document = { hidden: false, body: { scrollHeight: 1000 }, getElementById: el, addEventListener() {}, createElement: fakeEl };
  vm.runInContext(SRC, vm.createContext({ window, document, location, fetch: () => Promise.reject(new Error("offline")), setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, console, Promise, Date, Math, JSON, String, Number, Object, Array, RegExp, encodeURIComponent }));
  return {
    window,
    async open(id) { await window.TOJScreens.chat(id); },
    async tick() {
      const run = timers.splice(0);
      for (const fn of run) fn();
      await new Promise((r) => setTimeout(r, 80));
    },
    shown() { return [...el("msgs").innerHTML.matchAll(/data-id="(\d+)"/g)].map((m) => Number(m[1])); },
    async send(text) {
      el("box").value = text;
      el("send").fire("click");
      await new Promise((r) => setTimeout(r, 80));
    },
  };
}

test("a message someone sends just before yours still shows, and isn't marked read before you have it", async () => {
  const wes = await as("wes@example.com");
  const kyron = await as("kyron@example.com", "admin");
  await wes("/api/chat/me", { method: "POST", body: { name: "Wes", adult: true } });
  await kyron("/api/chat/me", { method: "POST", body: { name: "Kyron", adult: true } });
  const all = (await wes("/api/chat")).json.rooms.find((r) => r.kind === "all").id;
  await kyron(`/api/chat/rooms/${all}/messages`, { method: "POST", body: { body: "Morning, crew." } });
  const page = loadRoom(wes.cookie, "#chat/" + all);
  await page.open(all);
  await page.tick();
  const k = (await kyron(`/api/chat/rooms/${all}/messages`, { method: "POST", body: { body: "Field 3 needs a shooter at noon." } })).json.message;
  await page.send("On my way.");
  assert.equal((await wes("/api/chat")).json.rooms.find((r) => r.id === all).unread, 1, "sending didn't mark it read");
  await page.tick();
  const shown = page.shown();
  assert.ok(shown.includes(k.id), "Kyron's message is on screen: " + JSON.stringify(shown));
  assert.deepEqual(shown, [...shown].sort((a, b) => a - b), "in order");
  assert.equal(new Set(shown).size, shown.length, "no duplicates");
  assert.equal((await wes("/api/chat")).json.rooms.find((r) => r.id === all).unread, 0, "read once it's fetched");
});

test("a backlog bigger than a page between two checks all shows", async () => {
  const wes = await as("wes@example.com");
  const kyron = await as("kyron@example.com", "admin");
  const all = (await wes("/api/chat")).json.rooms.find((r) => r.kind === "all").id;
  const page = loadRoom(wes.cookie, "#chat/" + all);
  await page.open(all);
  // Seven quiet checks, then 130 messages land just before the eighth (the
  // one that also refreshes edits).
  for (let i = 0; i < 7; i++) await page.tick();
  const sent = [];
  for (let i = 0; i < 130; i++) {
    C.resetRate();
    sent.push((await kyron(`/api/chat/rooms/${all}/messages`, { method: "POST", body: { body: "Update " + i } })).json.message.id);
  }
  await page.tick();
  await page.tick();
  const shown = page.shown();
  assert.deepEqual(sent.filter((id) => !shown.includes(id)), [], "nothing missing");
});

test("merging: by id, in order, and an update-only pass adds nothing", async () => {
  const page = loadRoom(() => "", "#chat/x");
  // The screen runs in its own realm: compare plain copies.
  const merge = (...args) => JSON.parse(JSON.stringify(page.window.TOJChat.merge(...args)));
  const a = { id: 1, body: "a" }, c = { id: 3, body: "c" };
  let r = merge([a, c], [{ id: 2, body: "b" }, { id: 3, body: "c2", edited: true }]);
  assert.deepEqual(r.list.map((m) => m.id), [1, 2, 3]);
  assert.equal(r.list[2].body, "c2");
  assert.deepEqual(r.added.map((m) => m.id), [2]);
  r = merge(r.list, [{ id: 9, body: "new" }, { id: 1, body: null, removed: true }], true);
  assert.deepEqual(r.list.map((m) => m.id), [1, 2, 3]);
  assert.equal(r.list[0].removed, true);
  assert.equal(r.changed, true);
});
