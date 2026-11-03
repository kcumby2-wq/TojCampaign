// The tool shelf: links the owner adds to the app (a Claude page, a Milanote
// board, a Google Sheet), each shown to the people it's meant for. The rules
// are in utils/tools.js; the table in migration 031; the
// screens in public/app/shelf.js.
//
//   GET    /api/team-tools        the tools you can open (the owner also gets archived ones)
//   POST   /api/team-tools        { name, url, about?, audience? }   (owner)
//   PATCH  /api/team-tools/:id    any of those, or { archived: true|false }  (owner)
//
// Links are https only, with no sign-in details in them. They open outside
// the app; nothing on the shelf runs inside it.

"use strict";

const express = require("express");
const T = require("../utils/team");
const C = require("../utils/tools");
const { getSupabase } = require("../utils/supabase");

const router = express.Router();
const team = T.requireTeam(null, "viewer");

const safe = (fn) => (req, res, next) =>
  Promise.resolve()
    .then(() => fn(req, res, next))
    .catch((e) => {
      console.error("[team-tools] handler failed:", e && e.message);
      if (!res.headersSent) res.status(500).json({ error: "server_error" });
    });
const bodyOf = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});
function db(res) {
  const sb = getSupabase();
  if (!sb) res.status(503).json({ error: "supabase_unavailable" });
  return sb;
}
function fail(res, error) {
  if (error && (error.code === "42P01" || error.code === "PGRST205" || /does not exist|Could not find the table/i.test(String(error.message || "")))) {
    return res.status(503).json({ error: "shelf_not_set_up" });
  }
  throw new Error((error && error.message) || "database error");
}
const COLS = "id,name,url,about,audience,archived_at,created_by,created_at";

router.get("/", team, safe(async (req, res) => {
  const sb = db(res);
  if (!sb) return;
  const { data, error } = await sb.from("team_tools").select(COLS).order("name", { ascending: true });
  if (error) {
    // Before migration 031 the shelf is simply empty.
    if (/does not exist|Could not find the table/i.test(String(error.message || "")) || error.code === "42P01" || error.code === "PGRST205") return res.json({ tools: [], set_up: false });
    return fail(res, error);
  }
  const owner = !!req.team.owner;
  const tools = (data || [])
    .filter((t) => (owner ? true : !t.archived_at && C.sees(req.team, t.audience)))
    .map((t) => ({ id: t.id, name: t.name, url: t.url, about: t.about, audience: t.audience, archived: !!t.archived_at }));
  res.json({ tools, set_up: true, audiences: owner ? C.AUDIENCES : undefined });
}));

router.post("/", team, safe(async (req, res) => {
  if (!req.team.owner) return res.status(403).json({ error: "owner_only" });
  const sb = db(res);
  if (!sb) return;
  const { errors, value } = C.toolInput(bodyOf(req));
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });
  const { data, error } = await sb.from("team_tools").insert({ ...value, created_by: req.team.email }).select(COLS).single();
  if (error) return fail(res, error);
  T.logActivity(req.team.email, "tool_added", data.name);
  res.status(201).json({ tool: { id: data.id, name: data.name, url: data.url, about: data.about, audience: data.audience, archived: false } });
}));

router.patch("/:id", team, safe(async (req, res) => {
  if (!req.team.owner) return res.status(403).json({ error: "owner_only" });
  const sb = db(res);
  if (!sb) return;
  const id = String(req.params.id || "").toLowerCase();
  if (!C.UUID.test(id)) return res.status(404).json({ error: "not_found" });
  const b = bodyOf(req);
  const { errors, value } = C.toolInput(b, { partial: true });
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });
  if (b.archived !== undefined) value.archived_at = b.archived ? new Date().toISOString() : null;
  if (!Object.keys(value).length) return res.status(400).json({ error: "nothing_to_change" });
  value.updated_at = new Date().toISOString();
  const { data, error } = await sb.from("team_tools").update(value).eq("id", id).select(COLS);
  if (error) return fail(res, error);
  if (!data || !data.length) return res.status(404).json({ error: "not_found" });
  const t = data[0];
  res.json({ tool: { id: t.id, name: t.name, url: t.url, about: t.about, audience: t.audience, archived: !!t.archived_at } });
}));

module.exports = router;
