// Team API — who's on the team, invites, roles, and the activity log.
//
//   GET    /api/team/me                 → your access: role, tools, owner?
//   DELETE /api/team/me                 → delete your own account (not the owner's)
//   GET    /api/team                    → the team (any member; emails for owners only)
//   GET    /api/team/activity           → who did what (any member)
//   GET    /api/team/invites            → pending invites (owner)
//   POST   /api/team/invites            → invite someone (owner) → one-time token, shown once
//   POST   /api/team/invites/:id/renew  → a new link for the same invite (owner)
//   DELETE /api/team/invites/:id        → cancel an invite (owner)
//   PATCH  /api/team/members/:email     → change role, tools, regions or name (owner)
//   DELETE /api/team/members/:email     → remove from the team (owner)
//   GET    /api/team/join/:token        → what an invite is for (public, token holder)
//   POST   /api/team/join               → accept: set a password (or sign in) and join (public)
//
// Nothing here emails anyone: Kyron gets the link and sends it himself.

"use strict";

const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { requireStaff, staffEmails, ROLES: ACCOUNT_ROLES } = require("../utils/staff");
const T = require("../utils/team");
const { getSupabase } = require("../utils/supabase");

const router = express.Router();
const INVITE_DAYS = 7;
const PASSWORD_MIN = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FORMER = "former teammate"; // stands in for a deleted account's email

const hashToken = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
const newToken = () => crypto.randomBytes(32).toString("base64url");
const clean = (s, max) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, max);

function sb503(res) {
  return res.status(503).json({ error: "supabase_unavailable" });
}
function fail(res, e, what) {
  console.error(`[team] ${what} failed:`, e && e.message);
  return res.status(500).json({ error: `${what}_failed` });
}

function validTools(tools) {
  const list = Array.isArray(tools) ? tools.map(String) : ["studio"];
  const ok = list.filter((t) => Object.prototype.hasOwnProperty.call(T.GRANTABLE_TOOLS, t));
  return ok.length ? [...new Set(ok)] : ["studio"];
}
// Pylon events: a Regional Director (member) or viewer needs at least one
// region; approvers see every region, so theirs stay empty.
function validRegions(regions) {
  return [...new Set((Array.isArray(regions) ? regions : []).map(String).filter((r) => T.REGION_KEYS.includes(r)))];
}
function regionsFor(role, tools, regions) {
  if (!tools.includes("gfs") || role === "approver") return [];
  return validRegions(regions);
}
// Reads that work before and after migration 024 adds the regions column.
async function withRegions(build, cols) {
  let r = await build(cols + ",regions");
  if (r.error && T.missingColumn(r.error)) r = await build(cols);
  return r;
}

// Same as routes/auth.js signIn: a fresh session id, then who signed in.
function signIn(req, email, role) {
  return new Promise((resolve) => {
    req.session.regenerate((err) => {
      if (err) return resolve(false);
      req.session.userEmail = email;
      req.session.userRole = role;
      req.session.save((err2) => resolve(!err2));
    });
  });
}

// A few tries per minute per address for the public join endpoints.
const tries = new Map();
function throttled(req) {
  const key = req.ip || "x";
  const now = Date.now();
  const list = (tries.get(key) || []).filter((t) => now - t < 15 * 60 * 1000);
  list.push(now);
  tries.set(key, list);
  return list.length > 20;
}

// ── Me ───────────────────────────────────────────────────────────────────
router.get("/me", async (req, res) => {
  const email = T.emailOf(req);
  if (!email) return res.status(401).json({ error: "not_authenticated" });
  const a = await T.accessFor(req);
  if (!a) return res.json({ email, on_team: false });
  res.json({ on_team: true, ...a, tools_available: T.GRANTABLE_TOOLS });
});

// ── The team ─────────────────────────────────────────────────────────────
router.get("/", T.requireTeam(null, "viewer"), async (req, res) => {
  const sb = getSupabase();
  if (!sb) return sb503(res);
  try {
    const owners = [...staffEmails()];
    const { data: ownerRows } = owners.length
      ? await sb.from("users").select("email,role").in("email", owners)
      : { data: [] };
    const { data: members, error } = await withRegions(
      (cols) => sb.from("team_members").select(cols).eq("status", "active").order("joined_at", { ascending: true }),
      "email,name,role,tools,status,joined_at"
    );
    if (error) throw new Error(error.message);
    const showEmail = req.team.owner;
    const people = [
      ...(ownerRows || [])
        .filter((u) => ["staff", "admin"].includes(u.role))
        .map((u) => ({ email: u.email, name: null, role: "owner", tools: Object.keys(T.GRANTABLE_TOOLS), regions: [...T.REGION_KEYS], you: u.email === req.team.email })),
      ...(members || []).map((m) => ({ ...m, you: m.email === req.team.email })),
    ].map((p) => (showEmail || p.you ? p : { ...p, email: null }));
    res.json({ people, roles: T.MEMBER_ROLES, tools: T.GRANTABLE_TOOLS, regions: T.REGION_KEYS });
  } catch (e) {
    fail(res, e, "list_team");
  }
});

router.get("/activity", T.requireTeam(null, "viewer"), async (req, res) => {
  const sb = getSupabase();
  if (!sb) return sb503(res);
  const { data, error } = await sb
    .from("team_activity")
    .select("id,actor,action,subject,detail,created_at")
    .order("created_at", { ascending: false })
    .limit(Math.min(100, Number(req.query.limit) || 40));
  if (error) return fail(res, error, "activity");
  const { data: members } = await sb.from("team_members").select("email,name");
  const names = new Map((members || []).map((m) => [m.email, m.name]));
  res.json({
    activity: (data || []).map((a) => ({
      ...a,
      actor_name: names.get(a.actor) || (a.actor === "api-key" ? "Automation" : a.actor === FORMER ? "A former teammate" : staffEmails().has(a.actor) ? "Owner" : null),
      actor: req.team.owner || a.actor === req.team.email ? a.actor : null,
    })),
  });
});

// ── Invites (owner) ──────────────────────────────────────────────────────
router.get("/invites", requireStaff, async (_req, res) => {
  const sb = getSupabase();
  if (!sb) return sb503(res);
  const { data, error } = await withRegions(
    (cols) =>
      sb
        .from("team_invites")
        .select(cols)
        .is("used_at", null)
        .is("revoked_at", null)
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false }),
    "id,email,name,role,tools,invited_by,expires_at,created_at"
  );
  if (error) return fail(res, error, "list_invites");
  res.json({ invites: data || [] });
});

router.post("/invites", requireStaff, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return sb503(res);
  const email = String(req.body?.email || "").trim().toLowerCase();
  const role = String(req.body?.role || "member");
  if (!EMAIL_RE.test(email) || email.length > 200) return res.status(400).json({ error: "invalid_email" });
  if (!T.MEMBER_ROLES.includes(role)) return res.status(400).json({ error: "invalid_role", allowed: T.MEMBER_ROLES });
  if (staffEmails().has(email)) return res.status(409).json({ error: "already_an_owner" });
  try {
    const existing = await T.memberByEmail(email);
    if (existing && existing.status === "active") return res.status(409).json({ error: "already_on_team" });
    const tools = validTools(req.body?.tools);
    const regions = regionsFor(role, tools, req.body?.regions);
    if (tools.includes("gfs") && role !== "approver" && !regions.length) return res.status(400).json({ error: "regions_required", allowed: T.REGION_KEYS });
    const token = newToken();
    const row = {
      token_hash: hashToken(token),
      email,
      name: clean(req.body?.name, 80) || null,
      role,
      tools,
      invited_by: T.emailOf(req),
      expires_at: new Date(Date.now() + INVITE_DAYS * 86400000).toISOString(),
    };
    // Only Pylon-events invites carry regions (so invites keep working
    // before migration 024 is applied).
    if (tools.includes("gfs")) row.regions = regions;
    const { data, error } = await sb.from("team_invites").insert(row).select("id,email,name,role,tools,expires_at").single();
    if (error) throw new Error(error.message);
    await T.logActivity(T.emailOf(req), "invited", email, { role, tools, regions: row.regions });
    res.json({ invite: data, token, path: `/app/#join/${token}` });
  } catch (e) {
    fail(res, e, "invite");
  }
});

router.post("/invites/:id/renew", requireStaff, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return sb503(res);
  const token = newToken();
  const { data, error } = await sb
    .from("team_invites")
    .update({ token_hash: hashToken(token), expires_at: new Date(Date.now() + INVITE_DAYS * 86400000).toISOString() })
    .eq("id", req.params.id)
    .is("used_at", null)
    .is("revoked_at", null)
    .select("id,email,role,expires_at");
  if (error) return fail(res, error, "renew_invite");
  if (!data || !data.length) return res.status(404).json({ error: "not_found" });
  res.json({ invite: data[0], token, path: `/app/#join/${token}` });
});

router.delete("/invites/:id", requireStaff, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return sb503(res);
  const { data, error } = await sb
    .from("team_invites")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .is("used_at", null)
    .select("id,email");
  if (error) return fail(res, error, "cancel_invite");
  if (!data || !data.length) return res.status(404).json({ error: "not_found" });
  await T.logActivity(T.emailOf(req), "cancelled_invite", data[0].email);
  res.json({ ok: true });
});

// ── Members (owner) ──────────────────────────────────────────────────────
router.patch("/members/:email", requireStaff, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return sb503(res);
  const email = String(req.params.email || "").toLowerCase();
  const patch = { updated_at: new Date().toISOString() };
  if (req.body?.role !== undefined) {
    if (!T.MEMBER_ROLES.includes(req.body.role)) return res.status(400).json({ error: "invalid_role", allowed: T.MEMBER_ROLES });
    patch.role = req.body.role;
  }
  if (req.body?.tools !== undefined) patch.tools = validTools(req.body.tools);
  if (req.body?.name !== undefined) patch.name = clean(req.body.name, 80) || null;
  if (req.body?.regions !== undefined) patch.regions = validRegions(req.body.regions);
  const { data, error } = await sb.from("team_members").update(patch).eq("email", email).eq("status", "active").select("email,name,role,tools");
  if (error) return fail(res, error, "update_member");
  if (!data || !data.length) return res.status(404).json({ error: "not_found" });
  T.forget(email);
  await T.logActivity(T.emailOf(req), "changed_member", email, { role: patch.role, tools: patch.tools, regions: patch.regions });
  res.json({ member: data[0] });
});

router.delete("/members/:email", requireStaff, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return sb503(res);
  const email = String(req.params.email || "").toLowerCase();
  const { data, error } = await sb
    .from("team_members")
    .update({ status: "removed", updated_at: new Date().toISOString() })
    .eq("email", email)
    .eq("status", "active")
    .select("email");
  if (error) return fail(res, error, "remove_member");
  if (!data || !data.length) return res.status(404).json({ error: "not_found" });
  T.forget(email);
  await T.logActivity(T.emailOf(req), "removed_member", email);
  res.json({ ok: true });
});

// ── Deleting your own account ────────────────────────────────────────────
// Apple requires an app that creates accounts to let people delete them from
// inside the app (App Review Guideline 5.1.1(v)). This removes the sign-in,
// the team membership, pending invites and notification devices, and takes
// the email off the activity log and run records. Kits a person approved
// stay approved, credited to "a former teammate". The owner account is
// managed on the server (ADMIN_EMAILS) and can't be deleted from the app.

router.delete("/me", T.requireTeam(null, "viewer"), async (req, res) => {
  if (req.team.apiKey) return res.status(400).json({ error: "not_an_account" });
  if (req.team.owner) return res.status(400).json({ error: "owner_account" });
  if (!req.body || req.body.confirm !== true) return res.status(400).json({ error: "confirm_required" });
  const sb = getSupabase();
  if (!sb) return sb503(res);
  const email = req.team.email;
  try {
    const steps = [
      sb.from("push_subscriptions").delete().eq("email", email),
      sb.from("team_invites").delete().eq("email", email),
      sb.from("team_members").delete().eq("email", email),
      sb.from("team_activity").update({ actor: FORMER }).eq("actor", email),
      sb.from("team_activity").update({ subject: FORMER }).eq("subject", email),
      sb.from("agent_runs").update({ created_by: null }).eq("created_by", email),
      sb.from("studio_kits").update({ created_by: FORMER }).eq("created_by", email),
      sb.from("studio_kits").update({ approved_by: FORMER }).eq("approved_by", email),
    ];
    for (const step of steps) {
      const { error } = await step;
      if (error) throw new Error(error.message);
    }
    const { error: uErr } = await sb.from("users").delete().eq("email", email);
    if (uErr) throw new Error(uErr.message);
    T.forget(email);
    await T.logActivity(FORMER, "deleted_account", null);
    req.session.destroy(() => res.json({ ok: true }));
  } catch (e) {
    fail(res, e, "delete_account");
  }
});

// ── Joining (public, token holder) ───────────────────────────────────────
async function inviteByToken(sb, token) {
  if (!token || String(token).length < 20 || String(token).length > 100) return null;
  const { data } = await withRegions(
    (cols) => sb.from("team_invites").select(cols).eq("token_hash", hashToken(token)).maybeSingle(),
    "id,email,name,role,tools,invited_by,expires_at,used_at,revoked_at"
  );
  if (!data || data.used_at || data.revoked_at || new Date(data.expires_at) < new Date()) return null;
  return data;
}

router.get("/join/:token", async (req, res) => {
  if (throttled(req)) return res.status(429).json({ error: "too_many_tries" });
  const sb = getSupabase();
  if (!sb) return sb503(res);
  const inv = await inviteByToken(sb, req.params.token);
  if (!inv) return res.status(404).json({ error: "invite_not_valid", hint: "Ask Kyron for a new link." });
  const { data: user } = await sb.from("users").select("email").eq("email", inv.email).maybeSingle();
  res.json({ email: inv.email, name: inv.name, role: inv.role, tools: inv.tools || [], regions: inv.regions || [], invited_by: "Kyron", account_exists: !!user, password_min: PASSWORD_MIN });
});

router.post("/join", async (req, res) => {
  if (throttled(req)) return res.status(429).json({ error: "too_many_tries" });
  const sb = getSupabase();
  if (!sb) return sb503(res);
  const inv = await inviteByToken(sb, req.body?.token);
  if (!inv) return res.status(404).json({ error: "invite_not_valid", hint: "Ask Kyron for a new link." });
  const password = String(req.body?.password || "");
  const name = clean(req.body?.name, 80) || inv.name || null;
  try {
    const { data: user, error: uErr } = await sb.from("users").select("email,hash,role").eq("email", inv.email).maybeSingle();
    if (uErr) throw new Error(uErr.message);
    let accountRole;
    if (user) {
      // Existing account: prove it's yours with its password.
      if (!(await bcrypt.compare(password, user.hash))) return res.status(401).json({ error: "wrong_password" });
      accountRole = user.role || ACCOUNT_ROLES.LEGACY;
    } else {
      if (password.length < PASSWORD_MIN) return res.status(400).json({ error: "password_too_short", min: PASSWORD_MIN });
      const hash = await bcrypt.hash(password, 10);
      const { error } = await sb.from("users").insert({ email: inv.email, hash, role: ACCOUNT_ROLES.CREATOR });
      if (error) throw new Error(error.message);
      accountRole = ACCOUNT_ROLES.CREATOR;
    }
    // Use the invite first, so the same link can't add someone twice.
    const { data: used, error: useErr } = await sb
      .from("team_invites")
      .update({ used_at: new Date().toISOString() })
      .eq("id", inv.id)
      .is("used_at", null)
      .select("id");
    if (useErr) throw new Error(useErr.message);
    if (!used || !used.length) return res.status(409).json({ error: "invite_already_used" });
    const member = {
      email: inv.email,
      name,
      role: inv.role,
      tools: inv.tools,
      status: "active",
      invited_by: inv.invited_by,
      joined_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (Array.isArray(inv.regions)) member.regions = inv.regions;
    const { error: mErr } = await sb.from("team_members").upsert(member, { onConflict: "email" });
    if (mErr) throw new Error(mErr.message);
    T.forget(inv.email);
    await T.logActivity(inv.email, "joined", inv.email, { role: inv.role });
    if (!(await signIn(req, inv.email, accountRole))) return res.status(500).json({ error: "session_error" });
    res.json({ ok: true, email: inv.email, role: inv.role });
  } catch (e) {
    fail(res, e, "join");
  }
});

module.exports = router;
