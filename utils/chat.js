// Team chat — the pure rules behind rooms and direct messages (routes/chat.js
// stores, public/app/chat.js shows). No network, no database. Migration 026
// enforces the text rule and the room shapes in Postgres too.
//
// Who's in it: the team (owners and active team members), each of whom joins
// once by confirming they're 18 or older. Rooms:
//   all     everyone with Pylon events
//   region  everyone with Pylon events in that region
//   stop    everyone who can see that Pylon event
//   topic   the people listed (owners and approvers make them)
//   dm      two people (only when CHAT_DMS=on; off by default)
//   team    everyone on the team                                (migration 031)
//   kit     everyone with Studio, on one Studio kit             (031)
//   booking owners, on one Subject Medias booking               (031)
//   os      everyone with Operating Systems, on one build       (031)
//           (an Authority build: owners only, as in the OS tool)
//
// Text only. A message can't carry an email address or a phone number, and
// people talk about athletes by team and jersey number only.

"use strict";

const crypto = require("crypto");
const T = require("./team");
const G = require("./gfs");

const KINDS = Object.freeze(["all", "region", "stop", "topic", "dm", "team", "kit", "booking", "os"]);
// Rooms whose readers follow the team's roles, tools and regions (no member rows).
const DERIVED = Object.freeze(["all", "region", "stop", "team", "kit", "booking", "os"]);
// The rooms that hang on a piece of work, and the context each one needs.
const WORK = Object.freeze({ stop: "ev", kit: "kit", booking: "booking", os: "os" });
const KIT_SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
// Direct messages: Kyron chose team rooms and work conversations without
// them (Nov 3). CHAT_DMS=on on the server turns them on.
function dmsOn() {
  return String(process.env.CHAT_DMS || "").toLowerCase() === "on";
}
const NAME_MAX = 40;
const TITLE_MAX = 60;
const BODY_MAX = 2000;
const TOPIC_PEOPLE_MAX = 60;

// ── Text ─────────────────────────────────────────────────────────────────
// One line: names and titles.
function cleanLine(s, max) {
  return String(s == null ? "" : s)
    .replace(/[\u0000-\u001f\u007f\u00ad\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
// A message keeps its line breaks (at most one blank line in a row) and loses
// control and direction-override characters.
function cleanBody(s) {
  return String(s == null ? "" : s)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f\u00ad\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, "")
    .split("\n")
    .map((l) => l.replace(/\s+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Mirrors public.chat_text_ok (migration 026). The check runs on a
// normalized copy: compatibility forms folded (full-width digits and @,
// non-breaking and other Unicode spaces), invisible characters dropped,
// every kind of dash made a hyphen. A phone-length number right after tel:,
// sms:, callto:, facetime: or wa.me/ counts, written as a link writes it (no
// space after the colon), so "FaceTime: 3pm" and "SMS: 2 bounced" are fine. A
// long number elsewhere in a link doesn't (a URL's ID isn't a phone number).
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}/i;
const DIAL = /(^|[^a-z])(tel|sms|callto|facetime):\+?[0-9]([.()-]?[0-9]){6,}|wa\.me\/\+?[0-9]([.()-]?[0-9]){6,}/i;
const LINKS = /https?:\/\/[^ \t\n\r\f\v<>"']+/gi;
const US_PHONE = /(?<![0-9])(\+?1[ .-]?)?\(?[2-9][0-9]{2}\)?[ .-]?[0-9]{3}[ .-]?[0-9]{4}(?![0-9])/;
const INTL_PHONE = /(?<![0-9])\+[1-9]([ .-]?[0-9]){7,14}(?![0-9])/;
const INVISIBLE = /[\u00ad\u180e\u200b-\u200f\u2060-\u2064\ufeff]/g;
const DASHES = /[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g;
function forCheck(s) {
  return String(s == null ? "" : s).normalize("NFKC").replace(INVISIBLE, "").replace(DASHES, "-");
}
function hasContact(s) {
  const text = forCheck(s);
  if (EMAIL.test(text) || DIAL.test(text)) return true;
  const noLinks = text.replace(LINKS, " ");
  return US_PHONE.test(noLinks) || INTL_PHONE.test(noLinks);
}

// ── Rooms ────────────────────────────────────────────────────────────────
function slugFor(kind, key) {
  if (kind === "all") return "all";
  if (kind === "region") return "region:" + key;
  if (kind === "stop") return "stop:" + key;
  if (kind === "dm") return "dm:" + [...key].sort().join(":");
  if (kind === "topic") return "topic:" + (key || crypto.randomUUID());
  if (kind === "team") return "team";
  if (kind === "kit") {
    if (!KIT_SLUG.test(String(key))) throw new Error("bad kit slug");
    return "kit:" + key;
  }
  if (kind === "booking") return "booking:" + key;
  if (kind === "os") return "os:" + key;
  throw new Error("unknown room kind");
}

// Can this person (a team access, utils/team.js accessFor) read the room?
// ctx.event: the stop's event; ctx.kit, ctx.booking, ctx.os: the work a room
// hangs on (null when it's gone); ctx.member: on the room's member list.
function canRead(access, room, ctx = {}) {
  if (!access || !room) return false;
  const pylon = T.can(access, "gfs", "viewer");
  switch (room.kind) {
    case "all":
      return pylon;
    case "region":
      return pylon && G.canSee(access, room.region);
    case "stop":
      return pylon && !!ctx.event && G.canSee(access, ctx.event.region);
    case "topic":
      return !!ctx.member;
    case "dm":
      return dmsOn() && !!ctx.member;
    case "team":
      return true;
    case "kit":
      return T.can(access, "studio", "viewer") && !!ctx.kit;
    case "booking":
      // Bookings hold a family's contact: owners only, like the booking itself.
      return !!access.owner && !!ctx.booking;
    case "os":
      // Authority builds can hold minors' details: owners only, like the
      // Operating Systems tool itself (routes/os.js canSee).
      return T.can(access, "os", "viewer") && !!ctx.os && (ctx.os.vertical !== "authority" || !!access.owner);
    default:
      return false;
  }
}
function canMakeRooms(access) {
  return !!access && (access.owner || access.role === "approver");
}
function canManage(access, room) {
  return !!room && room.kind === "topic" && canMakeRooms(access);
}
// The owner can remove anyone's message; everyone can remove their own.
function canRemove(access, message, me) {
  if (!access || !message) return false;
  return access.owner || (!!me && message.author_id === me.id);
}

function roleLabel(access) {
  if (!access) return "Former teammate";
  if (access.owner) return "Owner";
  if (access.role === "approver") return "Approver";
  if (access.role === "member") return (access.tools || []).includes("gfs") ? "Regional Director" : "Member";
  return "Viewer";
}

function regionName(r) {
  return G.REGIONS[r] || r || "";
}
// A room's name as its reader sees it. ev: the stop's event; other: the other
// person in a DM ({ name } or null for a former teammate).
function titleOf(room, { ev, other, kit, booking, os, bookingTitle } = {}) {
  if (room.kind === "all") return "All of Pylon";
  if (room.kind === "region") return regionName(room.region) + " region";
  if (room.kind === "stop") return ev ? ev.name : "A Pylon stop";
  if (room.kind === "dm") return other && other.name ? other.name : "Former teammate";
  if (room.kind === "team") return "Team";
  if (room.kind === "kit") return kit && kit.title ? kit.title : "A Studio kit";
  if (room.kind === "booking") return booking && bookingTitle ? bookingTitle : "A booking";
  if (room.kind === "os") return os && os.name ? os.name : "An operating system";
  return room.title || "Room";
}
// What a notification may call a room: fixed words for a booking and an
// operating system build (a family's event, a client's name), never typed text.
function pushTitleOf(room, ctx = {}) {
  if (room.kind === "booking") return "A booking";
  if (room.kind === "os") return "An operating system build";
  return titleOf(room, ctx);
}
function audienceText(room, { ev } = {}) {
  if (room.kind === "all") return "Everyone with Pylon events";
  if (room.kind === "region") return "Everyone with Pylon events in " + regionName(room.region);
  if (room.kind === "stop") return "Everyone who can see this stop: owners, approvers and " + (ev ? regionName(ev.region) : "its region") + "'s team";
  if (room.kind === "dm") return "Just the two of you";
  if (room.kind === "team") return "Everyone on the team";
  if (room.kind === "kit") return "Everyone with Studio";
  if (room.kind === "booking") return "Owners";
  if (room.kind === "os") return "Everyone with Operating Systems";
  return "Only the people listed can read it";
}
// Shown at the top of every room.
function ruleFor(room, { ev } = {}) {
  const who =
    room.kind === "dm" ? "Only the two of you can read this." :
    room.kind === "topic" ? "Only the people listed can read this room." :
    room.kind === "booking" ? "Only owners can read this room." :
    audienceText(room, { ev }) + " can read this room, viewers included.";
  const where = room.kind === "booking" ? "the booking" : room.kind === "kit" || room.kind === "os" || room.kind === "team" || room.kind === "topic" || room.kind === "dm" ? "the app's tools" : "the event's tools";
  return who + " Talk about athletes by team and jersey number only: no names, contact details, film links, permission flags or takedown reasons. Those stay in " + where + ".";
}

// ── Mentions ─────────────────────────────────────────────────────────────
// "@Ana Lopez" mentions the room's Ana Lopez. Longer names win, so "@Ana
// Lopez" isn't also "@Ana". people: [{ id, name }].
function mentionsIn(body, people) {
  const text = String(body || "");
  if (!text.includes("@")) return [];
  const lower = text.toLowerCase();
  const found = new Set();
  const taken = [];
  const sorted = [...(people || [])].filter((p) => p && p.name).sort((a, b) => b.name.length - a.name.length);
  for (const p of sorted) {
    const needle = "@" + p.name.toLowerCase();
    let from = 0;
    for (;;) {
      const i = lower.indexOf(needle, from);
      if (i < 0) break;
      const end = i + needle.length;
      const next = lower[end];
      const ok = (i === 0 || !/[a-z0-9]/i.test(lower[i - 1])) && (next === undefined || !/[a-z0-9]/i.test(next));
      if (ok && !taken.some(([a, b]) => i < b && end > a)) {
        found.add(p.id);
        taken.push([i, end]);
      }
      from = end;
    }
  }
  return [...found];
}

// ── Sending too fast ─────────────────────────────────────────────────────
// 20 messages a minute per person, in memory.
const PER_MINUTE = 20;
const sent = new Map(); // person id -> [timestamps]
function tooFast(personId, now = Date.now()) {
  const list = (sent.get(personId) || []).filter((t) => now - t < 60000);
  if (list.length >= PER_MINUTE) {
    sent.set(personId, list);
    return true;
  }
  list.push(now);
  sent.set(personId, list);
  return false;
}
function resetRate() {
  sent.clear();
}
setInterval(() => {
  const now = Date.now();
  for (const [k, list] of sent) if (!list.some((t) => now - t < 60000)) sent.delete(k);
}, 60000).unref();

module.exports = {
  KINDS,
  DERIVED,
  WORK,
  KIT_SLUG,
  dmsOn,
  pushTitleOf,
  NAME_MAX,
  TITLE_MAX,
  BODY_MAX,
  TOPIC_PEOPLE_MAX,
  cleanLine,
  cleanBody,
  hasContact,
  slugFor,
  canRead,
  canMakeRooms,
  canManage,
  canRemove,
  roleLabel,
  regionName,
  titleOf,
  audienceText,
  ruleFor,
  mentionsIn,
  tooFast,
  resetRate,
};
