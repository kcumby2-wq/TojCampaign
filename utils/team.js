// The team — who may use which tool, at what level.
//
//   owner    — a staff account on ADMIN_EMAILS (utils/staff.js). Everything.
//   approver — approves kit drafts, and everything a member can do
//   member   — writes briefs, starts runs, reviews drafts; can't approve
//   viewer   — opens approved kits and copies cards
//
// Members live in public.team_members (migration 019), each with the tools
// they may open. Owner-only consoles (the Intake CRM with minors' data, money,
// the deal graph) still use requireStaff and are never granted here.

"use strict";

const { isStaff } = require("./staff");
const { getSupabase } = require("./supabase");

const ROLE_RANK = Object.freeze({ viewer: 1, member: 2, approver: 3, owner: 4 });
const MEMBER_ROLES = Object.freeze(["approver", "member", "viewer"]);
// Tools a member can be given. Others stay owner-only until they move into the app.
const GRANTABLE_TOOLS = Object.freeze({ studio: "Studio Kits", creators: "Creators" });

const CACHE_MS = 30 * 1000;
const cache = new Map(); // email -> { at, member }

function emailOf(req) {
  const e = req && req.session && req.session.userEmail;
  return e ? String(e).trim().toLowerCase() : "";
}

async function memberByEmail(email) {
  const hit = cache.get(email);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.member;
  const sb = getSupabase();
  if (!sb) return null;
  const { data, error } = await sb
    .from("team_members")
    .select("email,name,role,tools,status,joined_at")
    .eq("email", email)
    .maybeSingle();
  if (error) {
    console.error("[team] member lookup failed:", error.message);
    return null;
  }
  cache.set(email, { at: Date.now(), member: data || null });
  return data || null;
}

function forget(email) {
  if (email) cache.delete(String(email).toLowerCase());
  else cache.clear();
}

// { email, name, role, tools, owner } for the signed-in person, or null.
async function accessFor(req) {
  const email = emailOf(req);
  if (!email) return null;
  if (isStaff(req)) return { email, name: null, role: "owner", tools: Object.keys(GRANTABLE_TOOLS), owner: true };
  const m = await memberByEmail(email);
  if (!m || m.status !== "active" || !ROLE_RANK[m.role]) return null;
  return { email, name: m.name || null, role: m.role, tools: Array.isArray(m.tools) ? m.tools : [], owner: false };
}

function can(access, tool, minRole) {
  if (!access) return false;
  if (ROLE_RANK[access.role] < ROLE_RANK[minRole]) return false;
  return access.owner || !tool || access.tools.includes(tool);
}

// Middleware: signed in, on the team, with this tool, at least this role.
function requireTeam(tool, minRole = "viewer") {
  return async function (req, res, next) {
    try {
      const a = await accessFor(req);
      if (!a) {
        return emailOf(req)
          ? res.status(403).json({ error: "not_on_team" })
          : res.status(401).json({ error: "not_authenticated" });
      }
      if (!can(a, tool, minRole)) return res.status(403).json({ error: "role_too_low", need: minRole });
      req.team = a;
      next();
    } catch (e) {
      console.error("[team] access check failed:", e.message);
      res.status(500).json({ error: "access_check_failed" });
    }
  };
}

// The same, or a machine key acting as a member of that one tool (automation).
// A key can never approve, unlock rules or manage the team.
function requireTeamOrApiKey(headerName, envName, tool, minRole = "viewer") {
  const crypto = require("crypto");
  const team = requireTeam(tool, minRole);
  return function (req, res, next) {
    const given = req.headers[headerName];
    const expected = process.env[envName];
    if (given && expected && ROLE_RANK[minRole] <= ROLE_RANK.member) {
      const a = Buffer.from(String(given));
      const b = Buffer.from(String(expected));
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        req._apiKeyAuth = true;
        req.team = { email: "api-key", name: "Automation", role: "member", tools: [tool], owner: false, apiKey: true };
        return next();
      }
    }
    return team(req, res, next);
  };
}

// Who did what. Never pass an athlete's name, contact or film link here.
async function logActivity(actor, action, subject = null, detail = null) {
  const sb = getSupabase();
  if (!sb) return;
  try {
    const { error } = await sb.from("team_activity").insert({ actor, action, subject, detail });
    if (error) console.warn("[team] activity log failed:", error.message);
  } catch (e) {
    console.warn("[team] activity log failed:", e.message);
  }
}

module.exports = {
  ROLE_RANK,
  MEMBER_ROLES,
  GRANTABLE_TOOLS,
  accessFor,
  can,
  requireTeam,
  requireTeamOrApiKey,
  memberByEmail,
  forget,
  logActivity,
  emailOf,
};
