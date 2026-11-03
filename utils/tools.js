// The tool shelf: the rules for links the owner adds to the TOJ app (a Claude
// page, a Milanote board, a Google Sheet). routes/team-tools.js stores them;
// public/app/shelf.js shows them under Team > Tools; migration 031 makes the
// table. Each tool is for an audience: the whole team, people with one tool,
// or owners only.

"use strict";

const AUDIENCES = Object.freeze({
  team: "Everyone on the team",
  studio: "People with Studio",
  creators: "People with Creators",
  os: "People with Operating Systems",
  gfs: "People with Pylon events",
  owners: "Only owners",
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One line: control characters out, spaces squeezed, capped.
function line(v, max) {
  return String(v == null ? "" : v)
    .replace(/[\u0000-\u001f\u007f\u00ad\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function validAudience(a) {
  return Object.prototype.hasOwnProperty.call(AUDIENCES, a);
}

// Does this person (a team access, utils/team.js) see something for this audience?
function sees(access, audience) {
  if (!access || !validAudience(audience)) return false;
  if (access.owner) return true;
  if (audience === "team") return true;
  if (audience === "owners") return false;
  return Array.isArray(access.tools) && access.tools.includes(audience);
}

// https only, with no sign-in details in it.
function cleanUrl(v) {
  const s = line(v, 2001);
  if (!s || s.length > 2000) return null;
  let u;
  try {
    u = new URL(s);
  } catch (e) {
    return null;
  }
  if (u.protocol !== "https:" || !u.hostname || u.username || u.password) return null;
  const out = u.toString();
  return out.length <= 2000 ? out : null;
}

function toolInput(body, { partial = false } = {}) {
  const b = body || {};
  const out = {};
  const errors = [];
  if (!partial || b.name !== undefined) {
    const name = line(b.name, 61);
    if (!name || name.length > 60) errors.push("name");
    else out.name = name;
  }
  if (!partial || b.url !== undefined) {
    const url = cleanUrl(b.url);
    if (!url) errors.push("url");
    else out.url = url;
  }
  if (!partial || b.about !== undefined) {
    const about = line(b.about, 141);
    if (about.length > 140) errors.push("about");
    else out.about = about || null;
  }
  if (!partial || b.audience !== undefined) {
    const audience = b.audience === undefined ? "team" : String(b.audience);
    if (!validAudience(audience)) errors.push("audience");
    else out.audience = audience;
  }
  return { errors, value: out };
}

module.exports = { AUDIENCES, UUID, line, validAudience, sees, cleanUrl, toolInput };
