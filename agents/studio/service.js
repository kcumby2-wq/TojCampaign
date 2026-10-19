// Studio service — kit storage and run plumbing shared by
// routes/studio-agents.js and its tests. Storage is public.studio_kits
// (migration 018) through the Supabase service-role client; the approved
// baselines that ship in the repo (agents/studio/kits/*.json) are read-only.

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const K = require("./kit");

const SOURCE_MAX = 300000; // characters of source material per run
const SOURCE_EXCERPT = 30000; // what the judge sees of the source
const BRIEF_MAX = 6000;

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ""));
const isBuiltinId = (s) => /^builtin:[a-z0-9-]+:v\d+$/.test(String(s || ""));

// ── Signed template-image URLs ───────────────────────────────────────────
// The kit page is staff-only, but Milanote fetches a dragged image by its URL,
// without the staff cookie. Template images (placeholders, silhouettes, no
// real people) are therefore served to anyone holding a signed URL, and the
// signed URLs only appear on the staff-only kit page.
function assetSecret() {
  return process.env.STUDIO_ASSET_SECRET || process.env.SESSION_SECRET || "";
}

function signAsset(set, file) {
  const secret = assetSecret();
  if (!secret) return "";
  return crypto.createHmac("sha256", secret).update(`studio-asset:${set}/${file}`).digest("hex").slice(0, 32);
}

function verifyAsset(set, file, sig) {
  const want = signAsset(set, file);
  if (!want || typeof sig !== "string" || sig.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}

// The file behind /assets/:set/:file, or null. Only listed template files.
function assetPath(set, file) {
  if (!/^[a-z0-9-]+$/.test(String(set || "")) || !/^[a-z0-9-]+\.(jpg|png)$/.test(String(file || ""))) return null;
  const listed = K.templatesFor(set).some((t) => t.file === file);
  if (!listed) return null;
  const p = path.join(K.ASSETS_DIR, set, file);
  return fs.existsSync(p) ? p : null;
}

function imgSrcFor(kit, base = "/api/studio-agents") {
  const set = kit.assets;
  return (img) => {
    const t = K.templatesFor(set).find((x) => x.id === img);
    const file = t ? t.file : `${img}.jpg`;
    const sig = signAsset(set, file);
    return `${base}/assets/${set}/${encodeURIComponent(file)}${sig ? `?sig=${sig}` : ""}`;
  };
}

// ── The task the agent gets ──────────────────────────────────────────────
function buildTask({ mode, slug, brief, source = "", base = null, assets = null, allowLocked = false, today }) {
  const lines = [];
  if (mode === "build") lines.push(`Mode: BUILD a new kit. Slug: ${slug}.`);
  else lines.push(`Mode: REFRESH the approved kit "${slug}" (version ${base.version}, ${base.id}). Your draft starts as an exact copy of it.`);
  lines.push(`Today: ${today}.`);
  const n = K.templatesFor(assets).length;
  lines.push(`Template images: ${assets && n ? `${assets} (${n} templates; see kit_templates)` : "none for this kit (describe any image a designer should make in a note card)"}.`);
  lines.push(`Rule changes allowed: ${allowLocked ? "YES, for this run only" : "no (locked rule cards stay as they are)"}.`);
  lines.push("", "Brief from Kyron:", String(brief || "").trim());
  if (source) {
    lines.push("", `Source material (${source.length} characters):`, "<source>", source, "</source>");
  }
  return lines.join("\n");
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ── Reading kits ─────────────────────────────────────────────────────────
const LIST_COLS =
  "id,slug,version,status,title,base_kit_id,base_version,source_run_id,role,eval_status,check_blockers,created_by,approved_by,approved_at,created_at";

function builtinRow(b) {
  return {
    id: b.id,
    slug: b.slug,
    version: b.version,
    status: "approved",
    title: b.title,
    builtin: true,
    created_at: `${b.kit.as_of}T00:00:00Z`,
    created_by: "built in",
    approved_by: "Kyron (Oct 19, 2026 session)",
    eval_status: null,
    check_blockers: 0,
  };
}

async function listKits(sb) {
  const rows = [];
  if (sb) {
    const { data, error } = await sb.from("studio_kits").select(LIST_COLS).order("created_at", { ascending: false }).limit(100);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
  }
  const approvedSlugs = new Set(rows.filter((r) => r.status === "approved").map((r) => r.slug));
  for (const b of K.builtinKits()) {
    const row = builtinRow(b);
    if (approvedSlugs.has(b.slug)) row.status = "superseded";
    rows.push(row);
  }
  return rows;
}

async function getKit(sb, id) {
  if (isBuiltinId(id)) {
    const b = K.builtinKits().find((x) => x.id === id);
    if (!b) return null;
    const row = builtinRow(b);
    if (sb) {
      const { data } = await sb.from("studio_kits").select("id").eq("slug", b.slug).eq("status", "approved").maybeSingle();
      if (data) row.status = "superseded";
    }
    return { ...row, kit: b.kit };
  }
  if (!isUuid(id) || !sb) return null;
  const { data, error } = await sb.from("studio_kits").select(`${LIST_COLS},kit,summary,changes,discarded_by,discarded_at`).eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

// The approved version of a slug: the approved row, else the built-in one.
async function approvedKit(sb, slug) {
  if (sb) {
    const { data, error } = await sb.from("studio_kits").select(`${LIST_COLS},kit`).eq("slug", slug).eq("status", "approved").maybeSingle();
    if (error) throw new Error(error.message);
    if (data) return data;
  }
  const b = K.builtinKits().find((x) => x.slug === slug);
  return b ? { ...builtinRow(b), kit: b.kit } : null;
}

async function nextVersion(sb, slug) {
  let max = 0;
  for (const b of K.builtinKits()) if (b.slug === slug) max = Math.max(max, b.version);
  if (sb) {
    const { data, error } = await sb.from("studio_kits").select("version").eq("slug", slug).order("version", { ascending: false }).limit(1);
    if (error) throw new Error(error.message);
    if (data && data[0]) max = Math.max(max, data[0].version);
  }
  return max + 1;
}

function slugExists(sb, slug) {
  return K.builtinKits().some((b) => b.slug === slug) ||
    (sb
      ? sb.from("studio_kits").select("id").eq("slug", slug).limit(1).then(({ data }) => !!(data && data.length))
      : false);
}

// ── Saving a run's draft ─────────────────────────────────────────────────
// Returns { saved: false, reason } or { saved: true, id, version }.
async function saveDraft(sb, { stage, runId, role, result, slug, requestedBy }) {
  if (!stage || !stage.kit) return { saved: false, reason: "nothing_staged" };
  if (stage.mode === "refresh") {
    const d = K.diffKits(stage.base_kit, stage.kit);
    if (d.unchanged) return { saved: false, reason: "no_changes" };
  } else if (!stage.kit.columns.length) {
    return { saved: false, reason: "nothing_staged" };
  }
  const check = K.checkKit({ ...stage.kit, version: 1 });
  for (let attempt = 0; attempt < 3; attempt++) {
    const version = await nextVersion(sb, slug);
    const kit = { ...K.clone(stage.kit), slug, version, as_of: today() };
    const row = {
      slug,
      version,
      status: "draft",
      title: kit.title || slug,
      kit,
      base_kit_id: stage.base_id,
      base_version: stage.base_version,
      source_run_id: runId,
      role,
      eval_status: result.eval_status,
      check_blockers: check.blockers.length,
      summary: String(result.output || "").slice(0, 20000),
      changes: stage.ops,
      created_by: requestedBy || null,
    };
    const { data, error } = await sb.from("studio_kits").insert(row).select("id,version").single();
    if (!error) return { saved: true, id: data.id, version: data.version };
    if (error.code !== "23505") throw new Error(error.message); // not a version race
  }
  throw new Error("could not pick a version number");
}

function bannerFor(row) {
  const v = `v${row.version}`;
  if (row.builtin && row.status === "approved") return `Approved ${v} · the kit as built and approved on Oct 19, 2026`;
  if (row.status === "approved") return `Approved ${v} · approved by ${row.approved_by || "staff"}${row.approved_at ? ` on ${String(row.approved_at).slice(0, 10)}` : ""}`;
  if (row.status === "superseded") return `Superseded ${v} · a newer version is approved`;
  if (row.status === "discarded") return `Discarded ${v} · not for use`;
  const checks = row.eval_status === "failed_after_retries" ? "FAILED the agent checks, review closely" : row.eval_status ? `checks: ${row.eval_status.replace(/_/g, " ")}` : "";
  return `Draft ${v} · not approved yet${checks ? ` · ${checks}` : ""}${row.check_blockers ? ` · ${row.check_blockers} blocker(s) to fix before approval` : ""}`;
}

module.exports = {
  SOURCE_MAX,
  SOURCE_EXCERPT,
  BRIEF_MAX,
  isUuid,
  isBuiltinId,
  signAsset,
  verifyAsset,
  assetPath,
  imgSrcFor,
  buildTask,
  today,
  listKits,
  getKit,
  approvedKit,
  nextVersion,
  slugExists,
  saveDraft,
  bannerFor,
};
