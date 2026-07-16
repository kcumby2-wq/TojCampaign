// Hooks weekly-stats API — the ingest + retrieval surface for the Hooks
// marketing engine. Kyron pastes raw Notes-app stat lines here, they get
// parsed by Haiku, previewed, edited, then committed to hooks_weekly_stats.
// Downstream: scripts/build-hooks-card.mjs reads the same tables to generate
// branded PNGs, and the Roster Pulse agent reads them for its Monday report.
//
//   POST /api/hooks-stats/parse          → { paste } → { rows, usage }  (no DB write)
//   POST /api/hooks-stats/ingest         → { season, week, rows } → { created_athletes, stats_written }
//   GET  /api/hooks-stats/week           → ?season=&week= → leaderboard rows
//   GET  /api/hooks-stats/athletes       → ?q= → matched athletes
//   POST /api/hooks-stats/athletes       → upsert a canonical athlete
//   POST /api/hooks-stats/offers         → log an offer / commitment event
//   GET  /api/hooks-stats/pack-runs      → recent card-pack generations
//
// Auth: session cookie OR X-Hooks-API-Key header (same pattern as
// /api/hooks-agents), so Optimum, an iOS Shortcut, or an SMS relay can ingest
// without a browser session.

const express = require("express");
const { parseStatPaste } = require("../agents/hooks/parse-stats");
const router = express.Router();

let supabase = null;
function getSupabase() {
  if (supabase !== null) return supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return (supabase = false);
  try {
    const { createClient } = require("@supabase/supabase-js");
    supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return supabase;
  } catch {
    return (supabase = false);
  }
}

function requireAuth(req, res, next) {
  if (req.session && req.session.userEmail) return next();
  const apiKey = req.headers["x-hooks-api-key"];
  if (apiKey && apiKey === process.env.HOOKS_API_KEY) {
    req._apiKeyAuth = true;
    return next();
  }
  return res.status(401).json({ error: "not_authenticated" });
}

function actor(req) {
  return req.session?.userEmail || (req._apiKeyAuth ? "api-key" : "unknown");
}

// Normalizer: strip HS/Ac./abbreviations for canonical school join key.
function shortSchool(school) {
  if (!school) return null;
  return school
    .replace(/\s+(HS|Ac\.?|Academy|Christian)\b/gi, "")
    .replace(/\bN\.?\s+/g, "North ")
    .replace(/\bS\.?\s+/g, "South ")
    .replace(/\bE\.?\s+/g, "East ")
    .replace(/\bW\.?\s+/g, "West ")
    .replace(/\bFr\.?\s+/g, "Frisco ")
    .replace(/\bMans?\.?\s+/g, "Mansfield ")
    .replace(/\bPr\.?\s+/g, "Prosper ")
    .replace(/\s+/g, " ")
    .trim();
}

// Preview: parse a paste, don't write.
router.post("/parse", requireAuth, async (req, res) => {
  const { paste } = req.body || {};
  if (!paste || typeof paste !== "string" || paste.trim().length < 3) {
    return res.status(400).json({ error: "missing_paste" });
  }
  try {
    const out = await parseStatPaste(paste);
    // Enrich with school_short guess so the preview UI can show consistent naming.
    for (const row of out.rows) {
      if (!row.school_short && row.school_raw) {
        row.school_short = shortSchool(row.school_raw);
      }
    }
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error("[hooks-stats] parse failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Ingest confirmed rows into hooks_athletes + hooks_weekly_stats.
router.post("/ingest", requireAuth, async (req, res) => {
  const { season, week, rows } = req.body || {};
  if (!Number.isInteger(season) || !Number.isInteger(week)) {
    return res.status(400).json({ error: "season_and_week_required_ints" });
  }
  if (!Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ error: "rows_required" });
  }
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "supabase_unavailable" });

  const createdAthletes = [];
  const statsWritten = [];
  const errors = [];

  for (const row of rows) {
    try {
      if (!row.name || typeof row.name !== "string") {
        errors.push({ row, error: "missing_name" });
        continue;
      }

      let athleteId = row.athlete_id || null;

      if (!athleteId) {
        // Try to find an existing canonical athlete by (name, school).
        const nameKey = row.name.trim();
        const schoolKey = (row.school_raw || row.school || "").trim();
        const { data: existing, error: findErr } = await sb
          .from("hooks_athletes")
          .select("id,canonical_name,school")
          .ilike("canonical_name", nameKey)
          .maybeSingle();
        if (findErr && findErr.code !== "PGRST116") {
          errors.push({ row, error: findErr.message });
          continue;
        }
        if (existing) {
          athleteId = existing.id;
        } else {
          // Create canonical row
          const { data: created, error: insErr } = await sb
            .from("hooks_athletes")
            .insert({
              canonical_name: nameKey,
              name_variants: [nameKey],
              school: schoolKey || null,
              school_short: row.school_short || shortSchool(schoolKey),
              position: row.position || null,
              class_year: row.class_year || null,
              status: "active",
            })
            .select("id,canonical_name,school")
            .single();
          if (insErr) {
            errors.push({ row, error: insErr.message });
            continue;
          }
          athleteId = created.id;
          createdAthletes.push(created);
        }
      }

      // Upsert weekly stat row (unique on athlete+season+week).
      const statRow = {
        athlete_id: athleteId,
        season,
        week,
        position: row.position || null,
        receptions: row.receptions ?? null,
        rec_yards: row.rec_yards ?? null,
        rec_tds: row.rec_tds ?? null,
        rush_att: row.rush_att ?? null,
        rush_yards: row.rush_yards ?? null,
        rush_tds: row.rush_tds ?? null,
        apy: row.apy ?? null,
        notes: row.notes || null,
        raw_input: row.raw || null,
        parsed_by: row.parsed_by || "haiku",
        source: row.source || "paste",
        ingested_by: actor(req),
      };
      const { data: stat, error: statErr } = await sb
        .from("hooks_weekly_stats")
        .upsert(statRow, { onConflict: "athlete_id,season,week" })
        .select("id,athlete_id,rec_yards,rec_tds,receptions")
        .single();
      if (statErr) {
        errors.push({ row, error: statErr.message });
        continue;
      }
      statsWritten.push(stat);
    } catch (e) {
      errors.push({ row, error: e.message });
    }
  }

  res.json({
    ok: true,
    season,
    week,
    created_athletes: createdAthletes,
    stats_written: statsWritten.length,
    errors,
  });
});

// Week leaderboard — joined with canonical athlete info for card generation.
router.get("/week", requireAuth, async (req, res) => {
  const season = parseInt(req.query.season, 10);
  const week = parseInt(req.query.week, 10);
  if (!Number.isInteger(season) || !Number.isInteger(week)) {
    return res.status(400).json({ error: "season_and_week_required" });
  }
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "supabase_unavailable" });

  const { data, error } = await sb
    .from("hooks_weekly_stats")
    .select(
      "id,season,week,receptions,rec_yards,rec_tds,rush_att,rush_yards,rush_tds,apy,notes,posted_at,raw_input," +
        "athlete:hooks_athletes(id,canonical_name,school,school_short,position,class_year,headshot_url,prospect_edge_url,offer_count,top_apy,status,committed_to)"
    )
    .eq("season", season)
    .eq("week", week)
    .order("rec_yards", { ascending: false, nullsFirst: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ season, week, count: data.length, rows: data });
});

// Athlete search — used by the admin UI's "match to existing" chip.
router.get("/athletes", requireAuth, async (req, res) => {
  const q = (req.query.q || "").trim();
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "supabase_unavailable" });

  let query = sb
    .from("hooks_athletes")
    .select(
      "id,canonical_name,school,school_short,position,class_year,status,offer_count,top_apy,committed_to,prospect_edge_url,headshot_url"
    )
    .order("canonical_name", { ascending: true })
    .limit(100);
  if (q) query = query.ilike("canonical_name", `%${q}%`);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ count: data.length, athletes: data });
});

// Upsert a canonical athlete (edit headshot, prospect_edge_url, class_year, etc.)
router.post("/athletes", requireAuth, async (req, res) => {
  const patch = req.body || {};
  if (!patch.canonical_name) {
    return res.status(400).json({ error: "canonical_name_required" });
  }
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "supabase_unavailable" });

  patch.updated_at = new Date().toISOString();
  const { data, error } = patch.id
    ? await sb.from("hooks_athletes").update(patch).eq("id", patch.id).select().single()
    : await sb.from("hooks_athletes").insert(patch).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, athlete: data });
});

// Log an offer / commitment / signed event.
router.post("/offers", requireAuth, async (req, res) => {
  const { athlete_id, school, event_type, apy, event_date, source } = req.body || {};
  if (!athlete_id || !school) {
    return res.status(400).json({ error: "athlete_id_and_school_required" });
  }
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "supabase_unavailable" });

  const { data, error } = await sb
    .from("hooks_offer_events")
    .insert({
      athlete_id,
      school,
      event_type: event_type || "offer",
      apy: apy ?? null,
      event_date: event_date || new Date().toISOString().slice(0, 10),
      source: source || "manual",
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  // Bump the athlete's offer_count if this is an offer event.
  if ((event_type || "offer") === "offer") {
    await sb.rpc("hooks_bump_offer_count", { p_athlete_id: athlete_id }).then(
      () => {},
      async () => {
        // Fallback if the RPC isn't installed: read + write.
        const { data: cur } = await sb
          .from("hooks_athletes")
          .select("offer_count,top_apy")
          .eq("id", athlete_id)
          .maybeSingle();
        if (cur) {
          await sb
            .from("hooks_athletes")
            .update({
              offer_count: (cur.offer_count || 0) + 1,
              top_apy: Math.max(cur.top_apy || 0, apy || 0) || cur.top_apy,
              updated_at: new Date().toISOString(),
            })
            .eq("id", athlete_id);
        }
      }
    );
  }

  res.json({ ok: true, event: data });
});

// Card pack history — lets the admin UI show what's already shipped.
router.get("/pack-runs", requireAuth, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "supabase_unavailable" });

  const { data, error } = await sb
    .from("hooks_card_pack_runs")
    .select("id,season,week,card_type,athlete_count,filenames,generated_by,created_at")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ runs: data });
});

module.exports = router;
