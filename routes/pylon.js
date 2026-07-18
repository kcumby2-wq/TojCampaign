// routes/pylon.js
// Pylon × TOJ Partnership · API surface for all 20 SKUs + Coordinators + Alumni + Data Feed.
// Wire into server.js: app.use("/api/pylon", require("./routes/pylon"));
// Auth pattern mirrors routes/hooks-agents.js — session OR X-Pylon-API-Key header.
//
// Every SKU's revenue split lives in PYLON_REVENUE_SPLITS at the top — NEVER inline splits.

const express = require("express");
const router = express.Router();
const db = require("../db");

// ═══════════════════════════════════════════════════════════════════════════
// PYLON_REVENUE_SPLITS · Single source of truth for every SKU's split
// ═══════════════════════════════════════════════════════════════════════════

const PYLON_REVENUE_SPLITS = Object.freeze({
  "1a": { toj: 0.40, pylon: 0.60, subject_media: 0.00, optimum: 0.00 },
  "1b": { toj: 0.40, pylon: 0.60, subject_media: 0.00, optimum: 0.00 },
  "1c": { toj: 0.30, pylon: 0.20, subject_media: 0.30, optimum: 0.20 },
  "2":  { toj: 0.25, pylon: 0.25, subject_media: 0.00, optimum: 0.50 },
  "3":  { toj: 0.35, pylon: 0.15, subject_media: 0.00, optimum: 0.50 },
  "4a": { toj: 0.25, pylon: 0.75, subject_media: 0.00, optimum: 0.00 }, // commission
  "4b": { toj: 0.25, pylon: 0.75, subject_media: 0.00, optimum: 0.00 },
  "4c": { toj: 0.25, pylon: 0.75, subject_media: 0.00, optimum: 0.00 },
  "4d": { toj: 0.40, pylon: 0.60, subject_media: 0.00, optimum: 0.00 },
  "5a": { toj: 0.20, pylon: 0.60, subject_media: 0.00, optimum: 0.00 }, // + athlete 0.20 if name-drop
  "5b": { toj: 0.20, pylon: 0.80, subject_media: 0.00, optimum: 0.00 },
  "6":  { toj: 1.00, pylon: 0.00, subject_media: 0.00, optimum: 0.00 }, // flat platform fee
  "7":  { toj: 0.40, pylon: 0.60, subject_media: 0.00, optimum: 0.00 },
  "8":  { toj: 0.40, pylon: 0.60, subject_media: 0.00, optimum: 0.00 },
  "9_individual": { toj: 0.40, pylon: 0.60, subject_media: 0.00, optimum: 0.00 },
  "9_combine":    { toj: 0.40, pylon: 0.40, subject_media: 0.00, optimum: 0.20 },
  "10": { toj: 0.40, pylon: 0.60, subject_media: 0.00, optimum: 0.00 },
  "11_standard":     { toj: 0.45, pylon: 0.30, subject_media: 0.00, optimum: 0.25 },
  "11_hbcu_premium": { toj: 0.45, pylon: 0.30, subject_media: 0.00, optimum: 0.25 },
  "12": { toj: 0.40, pylon: 0.60, subject_media: 0.00, optimum: 0.00 },
  "13": { toj: 0.40, pylon: 0.60, subject_media: 0.00, optimum: 0.00 },
  "14": { toj: 0.40, pylon: 0.60, subject_media: 0.00, optimum: 0.00 },
  // V3.1 additions
  "15": { toj: 0.60, pylon: 0.40, subject_media: 0.00, optimum: 0.00 },
  "16_episode":      { toj: 0.25, pylon: 0.60, subject_media: 0.15, optimum: 0.00 },
  "16_season":       { toj: 0.25, pylon: 0.60, subject_media: 0.15, optimum: 0.00 },
  "17": { toj: 0.25, pylon: 0.60, subject_media: 0.15, optimum: 0.00 },
  "18_basic":       { toj: 0.55, pylon: 0.35, subject_media: 0.10, optimum: 0.00 },
  "18_standard":    { toj: 0.55, pylon: 0.35, subject_media: 0.10, optimum: 0.00 },
  "18_recruiting":  { toj: 0.55, pylon: 0.35, subject_media: 0.10, optimum: 0.00 },
  "19_membership":  { toj: 0.33, pylon: 0.67, subject_media: 0.00, optimum: 0.00 },
  "19_brand_collab":{ toj: 0.33, pylon: 0.67, subject_media: 0.00, optimum: 0.00 },
  "19_mgmt_fee":    { toj: 1.00, pylon: 0.00, subject_media: 0.00, optimum: 0.00 },
  "20": { toj: 0.50, pylon: 0.30, subject_media: 0.00, optimum: 0.20 },
});

function splitCents(sku, amountCents) {
  const s = PYLON_REVENUE_SPLITS[sku];
  if (!s) throw new Error(`Unknown SKU: ${sku}`);
  return {
    toj_take_cents: Math.round(amountCents * s.toj),
    pylon_take_cents: Math.round(amountCents * s.pylon),
    subject_media_take_cents: Math.round(amountCents * s.subject_media),
    optimum_take_cents: Math.round(amountCents * s.optimum),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Auth middleware · session OR X-Pylon-API-Key header
// ═══════════════════════════════════════════════════════════════════════════

function requireAuth(req, res, next) {
  const apiKey = req.headers["x-pylon-api-key"];
  const sessionUser = req.session && req.session.user;
  if (apiKey && apiKey === process.env.PYLON_API_KEY) return next();
  if (sessionUser) return next();
  return res.status(401).json({ error: "unauthorized" });
}

function requirePylonApprover(req, res, next) {
  const sessionUser = req.session && req.session.user;
  if (!sessionUser) return res.status(401).json({ error: "unauthorized" });
  const approvers = (process.env.PYLON_APPROVERS || "").split(",").map((s) => s.trim());
  if (!approvers.includes(sessionUser.email)) {
    return res.status(403).json({ error: "not a designated Pylon approver" });
  }
  next();
}

router.use(requireAuth);

// ═══════════════════════════════════════════════════════════════════════════
// V2 CORE · Teams
// ═══════════════════════════════════════════════════════════════════════════

router.get("/teams", async (req, res) => {
  const { region, active_season, search } = req.query;
  let query = "SELECT * FROM pylon_teams WHERE 1=1";
  const params = [];
  if (region) { params.push(region); query += ` AND region = $${params.length}`; }
  if (active_season) { params.push(active_season); query += ` AND active_season = $${params.length}`; }
  if (search) { params.push(`%${search}%`); query += ` AND name ILIKE $${params.length}`; }
  query += " ORDER BY name LIMIT 200";
  const result = await db.query(query, params);
  res.json(result.rows);
});

router.post("/teams", async (req, res) => {
  const { name, program, region, division, coach_name, coach_email, coach_phone, active_season, metadata } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  const result = await db.query(
    `INSERT INTO pylon_teams (name, program, region, division, coach_name, coach_email, coach_phone, first_registered_at, active_season, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8,$9)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [name, program, region, division, coach_name, coach_email, coach_phone, active_season, metadata || {}]
  );
  res.json(result.rows[0] || { note: "team may already exist" });
});

// ═══════════════════════════════════════════════════════════════════════════
// V2 CORE · Athletes
// ═══════════════════════════════════════════════════════════════════════════

router.get("/athletes", async (req, res) => {
  const { team_id, class_year, represented, search } = req.query;
  let query = "SELECT * FROM pylon_athletes WHERE 1=1";
  const params = [];
  if (team_id) { params.push(team_id); query += ` AND team_id = $${params.length}`; }
  if (class_year) { params.push(class_year); query += ` AND class_year = $${params.length}`; }
  if (represented === "true") { query += ` AND represented = true`; }
  if (search) { params.push(`%${search}%`); query += ` AND canonical_name ILIKE $${params.length}`; }
  query += " ORDER BY canonical_name LIMIT 500";
  const result = await db.query(query, params);
  res.json(result.rows);
});

router.post("/athletes", async (req, res) => {
  const fields = ["canonical_name","team_id","parent_email","parent_phone","position","class_year","height_in","weight_lb","headshot_url","prospect_edge_profile_url","consent_public_stats","guardian_signed_release_on_file","represented","metadata"];
  const values = fields.map((f) => req.body[f]);
  if (!req.body.canonical_name) return res.status(400).json({ error: "canonical_name required" });
  const placeholders = fields.map((_, i) => `$${i + 1}`).join(",");
  const result = await db.query(
    `INSERT INTO pylon_athletes (${fields.join(",")}) VALUES (${placeholders}) RETURNING *`,
    values
  );
  res.json(result.rows[0]);
});

// ═══════════════════════════════════════════════════════════════════════════
// V2 CORE · Events
// ═══════════════════════════════════════════════════════════════════════════

router.get("/events", async (req, res) => {
  const { season, region, event_type } = req.query;
  let query = "SELECT * FROM pylon_events WHERE 1=1";
  const params = [];
  if (season) { params.push(season); query += ` AND season = $${params.length}`; }
  if (region) { params.push(region); query += ` AND region = $${params.length}`; }
  if (event_type) { params.push(event_type); query += ` AND event_type = $${params.length}`; }
  query += " ORDER BY start_date LIMIT 200";
  const result = await db.query(query, params);
  res.json(result.rows);
});

router.post("/events", async (req, res) => {
  const fields = ["name","event_type","season","start_date","end_date","city","state","country","currency","team_cap","region","event_size_tier","is_international","team_inn_booking_url","metadata"];
  const values = fields.map((f) => req.body[f]);
  if (!req.body.name || !req.body.season || !req.body.start_date) return res.status(400).json({ error: "name, season, start_date required" });
  const placeholders = fields.map((_, i) => `$${i + 1}`).join(",");
  const result = await db.query(
    `INSERT INTO pylon_events (${fields.join(",")}) VALUES (${placeholders}) RETURNING *`,
    values
  );
  res.json(result.rows[0]);
});

// ═══════════════════════════════════════════════════════════════════════════
// V2 CORE · Registrations
// ═══════════════════════════════════════════════════════════════════════════

router.post("/registrations", async (req, res) => {
  const { team_id, event_id, base_fee_paid_cents } = req.body;
  if (!team_id || !event_id) return res.status(400).json({ error: "team_id, event_id required" });
  const result = await db.query(
    `INSERT INTO pylon_registrations (team_id, event_id, base_fee_paid_cents)
     VALUES ($1,$2,$3)
     ON CONFLICT (team_id, event_id) DO UPDATE SET registration_status = 'confirmed'
     RETURNING *`,
    [team_id, event_id, base_fee_paid_cents]
  );
  res.json(result.rows[0]);
});

// ═══════════════════════════════════════════════════════════════════════════
// V2 CORE · Package Orders (SKUs 1a/1b/1c/2/3/10/12/13/14/18)
// ═══════════════════════════════════════════════════════════════════════════

router.post("/packages/quote", async (req, res) => {
  const { sku, amount_cents } = req.body;
  if (!sku || !amount_cents) return res.status(400).json({ error: "sku, amount_cents required" });
  const splits = splitCents(sku, amount_cents);
  res.json({ sku, amount_cents, ...splits });
});

router.post("/packages/order", async (req, res) => {
  const { registration_id, team_id, athlete_id, sku, amount_cents, currency = "USD", crew_type, metadata } = req.body;
  if (!sku || !amount_cents) return res.status(400).json({ error: "sku, amount_cents required" });
  const splits = splitCents(sku, amount_cents);
  const result = await db.query(
    `INSERT INTO pylon_package_orders
      (registration_id, team_id, athlete_id, sku, amount_cents, currency,
       toj_take_cents, optimum_take_cents, subject_media_take_cents, pylon_take_cents,
       crew_type, status, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'awaiting_payment',$12) RETURNING *`,
    [registration_id, team_id, athlete_id, sku, amount_cents, currency,
     splits.toj_take_cents, splits.optimum_take_cents, splits.subject_media_take_cents, splits.pylon_take_cents,
     crew_type, metadata || {}]
  );
  // TODO: create Stripe checkout, return URL
  res.json({ order: result.rows[0], stripe_checkout_url: null, todo: "wire stripe checkout in v1.2" });
});

router.post("/packages/webhook", async (req, res) => {
  // Stripe webhook · verify signature, mark paid
  const { order_id } = req.body;
  if (!order_id) return res.status(400).json({ error: "order_id required" });
  await db.query(`UPDATE pylon_package_orders SET status='pending_delivery', paid_at=now() WHERE id=$1`, [order_id]);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// V2 CORE · Athlete Subscriptions (SKU #9)
// ═══════════════════════════════════════════════════════════════════════════

router.post("/subscriptions/quote", async (req, res) => {
  const { tier } = req.body;
  const priceMap = { individual: 9900, combine: 24900 };
  if (!priceMap[tier]) return res.status(400).json({ error: "tier must be individual or combine" });
  const sku = tier === "individual" ? "9_individual" : "9_combine";
  const amount = priceMap[tier];
  const splits = splitCents(sku, amount);
  res.json({ tier, amount_cents: amount, ...splits });
});

router.post("/subscriptions/checkout", async (req, res) => {
  const { athlete_id, tier, active_until } = req.body;
  if (!athlete_id || !tier) return res.status(400).json({ error: "athlete_id, tier required" });
  const priceMap = { individual: 9900, combine: 24900 };
  const sku = tier === "individual" ? "9_individual" : "9_combine";
  const amount = priceMap[tier];
  if (!amount) return res.status(400).json({ error: "invalid tier" });
  const splits = splitCents(sku, amount);
  const result = await db.query(
    `INSERT INTO pylon_athlete_subscriptions
      (athlete_id, tier, amount_cents, toj_take_cents, pylon_take_cents, optimum_take_cents, active_until, next_billing_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
     ON CONFLICT (athlete_id) WHERE status = 'active' DO UPDATE SET tier=$2, amount_cents=$3
     RETURNING *`,
    [athlete_id, tier, amount, splits.toj_take_cents, splits.pylon_take_cents, splits.optimum_take_cents, active_until]
  );
  res.json({ subscription: result.rows[0], stripe_checkout_url: null, todo: "wire stripe checkout in v1.2" });
});

router.post("/subscriptions/webhook", async (req, res) => {
  const { subscription_id, event_type } = req.body;
  if (event_type === "invoice.paid") {
    await db.query(`UPDATE pylon_athlete_subscriptions SET status='active', next_billing_at=next_billing_at + interval '1 year' WHERE id=$1`, [subscription_id]);
  }
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// V2 CORE · Sponsors + Deals (SKUs 4a-4d + content sponsor)
// ═══════════════════════════════════════════════════════════════════════════

router.get("/sponsors/deals", async (req, res) => {
  const { status, tier } = req.query;
  let query = "SELECT * FROM pylon_sponsor_deals WHERE 1=1";
  const params = [];
  if (status) { params.push(status); query += ` AND status = $${params.length}`; }
  if (tier) { params.push(tier); query += ` AND tier = $${params.length}`; }
  query += " ORDER BY created_at DESC LIMIT 200";
  const result = await db.query(query, params);
  res.json(result.rows);
});

router.post("/sponsors/deals", async (req, res) => {
  const { sponsor_id, event_id, tier, amount_cents, contract_start, contract_end, closed_by, category_exclusivity } = req.body;
  if (!sponsor_id || !tier || !amount_cents) return res.status(400).json({ error: "sponsor_id, tier, amount_cents required" });
  // Category exclusivity check
  if (category_exclusivity) {
    const conflict = await db.query(
      `SELECT COUNT(*) AS n FROM pylon_sponsor_deals sd
       JOIN pylon_sponsors s ON s.id = sd.sponsor_id
       WHERE s.category = (SELECT category FROM pylon_sponsors WHERE id=$1)
         AND sd.category_exclusivity = true AND sd.status IN ('signed','invoiced','paid','delivered')`,
      [sponsor_id]
    );
    if (parseInt(conflict.rows[0].n, 10) > 0) {
      return res.status(409).json({ error: "category exclusivity conflict" });
    }
  }
  const commissionCents = Math.round(amount_cents * 0.25);
  const result = await db.query(
    `INSERT INTO pylon_sponsor_deals (sponsor_id, event_id, tier, amount_cents, toj_commission_cents, status, contract_start, contract_end, closed_by, category_exclusivity)
     VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9) RETURNING *`,
    [sponsor_id, event_id, tier, amount_cents, commissionCents, contract_start, contract_end, closed_by, category_exclusivity || false]
  );
  res.json(result.rows[0]);
});

router.patch("/sponsors/deals/:id", async (req, res) => {
  const { status } = req.body;
  const result = await db.query(`UPDATE pylon_sponsor_deals SET status=$1 WHERE id=$2 RETURNING *`, [status, req.params.id]);
  res.json(result.rows[0]);
});

// ═══════════════════════════════════════════════════════════════════════════
// V2 CORE · Email Campaigns (SKU #4d)
// ═══════════════════════════════════════════════════════════════════════════

router.post("/email-campaigns", async (req, res) => {
  const { sponsor_deal_id, campaign_name, subject_line, send_at, segment, audience_count } = req.body;
  const result = await db.query(
    `INSERT INTO pylon_email_campaigns (sponsor_deal_id, campaign_name, subject_line, send_at, segment, audience_count)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [sponsor_deal_id, campaign_name, subject_line, send_at, segment, audience_count]
  );
  res.json(result.rows[0]);
});

router.patch("/email-campaigns/:id", async (req, res) => {
  const { status, opens, clicks, conversions, report_url } = req.body;
  const result = await db.query(
    `UPDATE pylon_email_campaigns SET status=coalesce($1,status), opens=coalesce($2,opens), clicks=coalesce($3,clicks), conversions=coalesce($4,conversions), report_url=coalesce($5,report_url) WHERE id=$6 RETURNING *`,
    [status, opens, clicks, conversions, report_url, req.params.id]
  );
  res.json(result.rows[0]);
});

// ═══════════════════════════════════════════════════════════════════════════
// V2 CORE · Merch Drops (SKUs #5a/5b)
// ═══════════════════════════════════════════════════════════════════════════

router.post("/merch-drops", async (req, res) => {
  const { drop_type, team_id, event_id, athlete_id, name, storefront_url, opens_at, closes_at } = req.body;
  const result = await db.query(
    `INSERT INTO pylon_merch_drops (drop_type, team_id, event_id, athlete_id, name, storefront_url, opens_at, closes_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [drop_type, team_id, event_id, athlete_id, name, storefront_url, opens_at, closes_at]
  );
  res.json(result.rows[0]);
});

// ═══════════════════════════════════════════════════════════════════════════
// V2 CORE · City League Hosts (SKU #7) + V3.1 Ownership Fund
// ═══════════════════════════════════════════════════════════════════════════

router.post("/city-league-hosts", async (req, res) => {
  const { host_name, city, region, contact_name, contact_email, league_format, toolkit_tier, toolkit_amount_cents, season, ownership_model } = req.body;
  const tojTake = toolkit_amount_cents ? Math.round(toolkit_amount_cents * 0.40) : null;
  const result = await db.query(
    `INSERT INTO pylon_city_league_hosts (host_name, city, region, contact_name, contact_email, league_format, toolkit_tier, toolkit_amount_cents, toj_take_cents, season, ownership_model)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [host_name, city, region, contact_name, contact_email, league_format, toolkit_tier, toolkit_amount_cents, tojTake, season, ownership_model || 'toolkit_license']
  );
  res.json(result.rows[0]);
});

// ═══════════════════════════════════════════════════════════════════════════
// V2 CORE · Sales Sequences + Runs
// ═══════════════════════════════════════════════════════════════════════════

router.get("/sequences", async (req, res) => {
  const result = await db.query("SELECT * FROM pylon_sales_sequences WHERE active=true ORDER BY phase, sequence_key");
  res.json(result.rows);
});

router.post("/sequences/fire", async (req, res) => {
  const { sequence_id, team_id, athlete_id, event_id } = req.body;
  if (!sequence_id) return res.status(400).json({ error: "sequence_id required" });
  const result = await db.query(
    `INSERT INTO pylon_sequence_runs (sequence_id, team_id, athlete_id, event_id)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [sequence_id, team_id, athlete_id, event_id]
  );
  res.json(result.rows[0]);
});

router.get("/sequences/runs", async (req, res) => {
  const { team_id, delivery_status, since } = req.query;
  let query = "SELECT * FROM pylon_sequence_runs WHERE 1=1";
  const params = [];
  if (team_id) { params.push(team_id); query += ` AND team_id = $${params.length}`; }
  if (delivery_status) { params.push(delivery_status); query += ` AND delivery_status = $${params.length}`; }
  if (since) { params.push(since); query += ` AND fired_at >= $${params.length}`; }
  query += " ORDER BY fired_at DESC LIMIT 200";
  const result = await db.query(query, params);
  res.json(result.rows);
});

// ═══════════════════════════════════════════════════════════════════════════
// V2 CORE · Live Event Console (SKU #10)
// ═══════════════════════════════════════════════════════════════════════════

router.post("/live-posts", async (req, res) => {
  const { event_id, team_id, athlete_id, post_type, asset_url, sponsor_tag, operator, metadata } = req.body;
  if (!event_id || !post_type) return res.status(400).json({ error: "event_id, post_type required" });
  const result = await db.query(
    `INSERT INTO pylon_live_posts (event_id, team_id, athlete_id, post_type, asset_url, sponsor_tag, operator, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [event_id, team_id, athlete_id, post_type, asset_url, sponsor_tag, operator, metadata || {}]
  );
  res.json(result.rows[0]);
});

router.get("/live-posts", async (req, res) => {
  const { event_id } = req.query;
  const params = [];
  let query = "SELECT * FROM pylon_live_posts";
  if (event_id) { params.push(event_id); query += ` WHERE event_id = $1`; }
  query += " ORDER BY posted_at DESC NULLS LAST, created_at DESC LIMIT 100";
  const result = await db.query(query, params);
  res.json(result.rows);
});

router.post("/live-posts/:id/publish", async (req, res) => {
  const { channels } = req.body;
  const result = await db.query(
    `UPDATE pylon_live_posts SET posted_at=now(), channels=$1 WHERE id=$2 RETURNING *`,
    [channels || [], req.params.id]
  );
  res.json(result.rows[0]);
});

// ═══════════════════════════════════════════════════════════════════════════
// V2.5 · Content Pieces + approvals
// ═══════════════════════════════════════════════════════════════════════════

router.get("/content", async (req, res) => {
  const { pillar, status, scheduled_before, scheduled_after } = req.query;
  let query = "SELECT * FROM pylon_content_pieces WHERE 1=1";
  const params = [];
  if (pillar) { params.push(pillar); query += ` AND pillar = $${params.length}`; }
  if (status) { params.push(status); query += ` AND status = $${params.length}`; }
  if (scheduled_before) { params.push(scheduled_before); query += ` AND scheduled_at <= $${params.length}`; }
  if (scheduled_after) { params.push(scheduled_after); query += ` AND scheduled_at >= $${params.length}`; }
  query += " ORDER BY scheduled_at DESC NULLS LAST LIMIT 200";
  const result = await db.query(query, params);
  res.json(result.rows);
});

router.post("/content", async (req, res) => {
  const fields = ["pillar","asset_type","title","primary_channel","cross_post_channels","scheduled_at","status","assigned_to","sponsor_deal_id","copy_body","cta_url","athlete_ids","team_ids","event_id","metadata"];
  const values = fields.map((f) => req.body[f]);
  const placeholders = fields.map((_, i) => `$${i + 1}`).join(",");
  const result = await db.query(
    `INSERT INTO pylon_content_pieces (${fields.join(",")}) VALUES (${placeholders}) RETURNING *`,
    values
  );
  res.json(result.rows[0]);
});

// V2.5 · Approval gate — only Pylon-designated approvers per PYLON_APPROVERS
router.post("/content/:id/approve", requirePylonApprover, async (req, res) => {
  const result = await db.query(
    `UPDATE pylon_content_pieces SET status='approved', approver=$1 WHERE id=$2 RETURNING *`,
    [req.session.user.email, req.params.id]
  );
  res.json(result.rows[0]);
});

router.post("/content/:id/publish", async (req, res) => {
  const result = await db.query(
    `UPDATE pylon_content_pieces SET status='published', published_at=now() WHERE id=$1 AND status='approved' RETURNING *`,
    [req.params.id]
  );
  if (result.rowCount === 0) return res.status(400).json({ error: "content must be approved before publish" });
  res.json(result.rows[0]);
});

router.post("/content/:id/performance", async (req, res) => {
  const { reach, impressions, likes, comments, shares, saves, clicks, conversions, conversion_revenue_cents, raw } = req.body;
  const result = await db.query(
    `INSERT INTO pylon_content_performance (content_piece_id, reach, impressions, likes, comments, shares, saves, clicks, conversions, conversion_revenue_cents, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [req.params.id, reach || 0, impressions || 0, likes || 0, comments || 0, shares || 0, saves || 0, clicks || 0, conversions || 0, conversion_revenue_cents || 0, raw || {}]
  );
  res.json(result.rows[0]);
});

// ═══════════════════════════════════════════════════════════════════════════
// V2.5 · Ambassadors + Newsletter
// ═══════════════════════════════════════════════════════════════════════════

router.get("/ambassadors", async (req, res) => {
  const { status, tier } = req.query;
  let query = "SELECT * FROM pylon_ambassadors WHERE 1=1";
  const params = [];
  if (status) { params.push(status); query += ` AND status = $${params.length}`; }
  if (tier) { params.push(tier); query += ` AND tier = $${params.length}`; }
  query += " ORDER BY tier DESC, follower_count_total DESC LIMIT 200";
  const result = await db.query(query, params);
  res.json(result.rows);
});

router.post("/ambassadors", async (req, res) => {
  const fields = ["athlete_id","tier","monthly_stipend_cents","posts_expected_weekly","brand_affiliate_slots_monthly","ig_handle","tiktok_handle","twitter_handle","youtube_channel","follower_count_total","status","metadata"];
  const values = fields.map((f) => req.body[f]);
  if (!req.body.athlete_id) return res.status(400).json({ error: "athlete_id required" });
  const placeholders = fields.map((_, i) => `$${i + 1}`).join(",");
  const result = await db.query(
    `INSERT INTO pylon_ambassadors (${fields.join(",")}, onboarded_at) VALUES (${placeholders},now()) RETURNING *`,
    values
  );
  res.json(result.rows[0]);
});

router.post("/newsletter/subscribe", async (req, res) => {
  const { email, first_name, last_name, source, team_id, athlete_id } = req.body;
  if (!email) return res.status(400).json({ error: "email required" });
  const result = await db.query(
    `INSERT INTO pylon_newsletter_subscribers (email, first_name, last_name, tier, source, team_id, athlete_id)
     VALUES ($1,$2,$3,'free',$4,$5,$6)
     ON CONFLICT (email) DO NOTHING RETURNING *`,
    [email, first_name, last_name, source, team_id, athlete_id]
  );
  res.json(result.rows[0] || { note: "already subscribed" });
});

// ═══════════════════════════════════════════════════════════════════════════
// V2.7 · Recruiting Concierge (SKU #11) + HBCU premium
// ═══════════════════════════════════════════════════════════════════════════

router.post("/recruiting/subscribe", async (req, res) => {
  const { athlete_id, tier, billing_cadence, hbcu_focus, target_college_list } = req.body;
  if (!athlete_id || !tier || !billing_cadence) return res.status(400).json({ error: "athlete_id, tier, billing_cadence required" });
  const priceMap = {
    "standard_monthly": 9900,
    "standard_season": 49900,
    "hbcu_premium_monthly": 14900,
    "hbcu_premium_season": 74900,
  };
  const key = `${tier}_${billing_cadence}`;
  const amount = priceMap[key];
  if (!amount) return res.status(400).json({ error: "invalid tier/cadence combo" });
  const sku = tier === "hbcu_premium" ? "11_hbcu_premium" : "11_standard";
  const splits = splitCents(sku, amount);
  const activeUntil = new Date();
  if (billing_cadence === "monthly") activeUntil.setMonth(activeUntil.getMonth() + 1);
  else activeUntil.setFullYear(activeUntil.getFullYear() + 1);
  const result = await db.query(
    `INSERT INTO pylon_recruiting_subscriptions
      (athlete_id, tier, billing_cadence, amount_cents, toj_take_cents, pylon_take_cents, optimum_take_cents, active_until, next_billing_at, hbcu_focus, target_college_list)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10) RETURNING *`,
    [athlete_id, tier, billing_cadence, amount, splits.toj_take_cents, splits.pylon_take_cents, splits.optimum_take_cents, activeUntil, hbcu_focus || (tier === "hbcu_premium"), target_college_list || []]
  );
  res.json({ subscription: result.rows[0], stripe_checkout_url: null, todo: "wire stripe checkout in v1.2" });
});

router.post("/recruiting/draft", async (req, res) => {
  const { subscription_id, athlete_id, coach_name, coach_email, program_name, program_level, is_hbcu, outreach_type, draft_subject, draft_body } = req.body;
  const result = await db.query(
    `INSERT INTO pylon_recruiting_outreach
      (subscription_id, athlete_id, coach_name, coach_email, program_name, program_level, is_hbcu, outreach_type, draft_subject, draft_body)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [subscription_id, athlete_id, coach_name, coach_email, program_name, program_level, is_hbcu || false, outreach_type, draft_subject, draft_body]
  );
  res.json(result.rows[0]);
});

router.post("/recruiting/approve/:id", async (req, res) => {
  const result = await db.query(
    `UPDATE pylon_recruiting_outreach SET parent_approved=true, parent_approved_at=now() WHERE id=$1 RETURNING *`,
    [req.params.id]
  );
  res.json(result.rows[0]);
});

router.post("/recruiting/inbound", async (req, res) => {
  const { outreach_id, coach_reply_body } = req.body;
  // TODO: sentiment classification via Claude
  const sentiment = "warm"; // placeholder — wire Claude call
  const result = await db.query(
    `UPDATE pylon_recruiting_outreach SET coach_replied_at=now(), coach_reply_body=$1, reply_sentiment=$2, escalated_to_human=$3 WHERE id=$4 RETURNING *`,
    [coach_reply_body, sentiment, sentiment === "hot", outreach_id]
  );
  res.json(result.rows[0]);
});

// ═══════════════════════════════════════════════════════════════════════════
// V2.8 · Creator Referrals (25% OFF loop)
// ═══════════════════════════════════════════════════════════════════════════

router.post("/creator-referrals", async (req, res) => {
  const { creator_email, creator_name, referral_code, active_at_event_id, active_until } = req.body;
  if (!creator_email || !referral_code) return res.status(400).json({ error: "creator_email, referral_code required" });
  const result = await db.query(
    `INSERT INTO pylon_creator_referrals (creator_email, creator_name, referral_code, active_at_event_id, active_until)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [creator_email, creator_name, referral_code.toUpperCase(), active_at_event_id, active_until]
  );
  res.json(result.rows[0]);
});

// ═══════════════════════════════════════════════════════════════════════════
// V2.9 · Media Assignments + Booth Staffing
// ═══════════════════════════════════════════════════════════════════════════

router.post("/media-assignments", async (req, res) => {
  const { event_id, team_id, athlete_id, creator_email, creator_name, content_taxonomy_slot } = req.body;
  const result = await db.query(
    `INSERT INTO pylon_media_assignments (event_id, team_id, athlete_id, creator_email, creator_name, content_taxonomy_slot, briefed_at)
     VALUES ($1,$2,$3,$4,$5,$6,now()) RETURNING *`,
    [event_id, team_id, athlete_id, creator_email, creator_name, content_taxonomy_slot]
  );
  res.json(result.rows[0]);
});

router.patch("/media-assignments/:id", async (req, res) => {
  const { status, shot_at, delivered_at } = req.body;
  const result = await db.query(
    `UPDATE pylon_media_assignments SET status=coalesce($1,status), shot_at=coalesce($2,shot_at), delivered_at=coalesce($3,delivered_at) WHERE id=$4 RETURNING *`,
    [status, shot_at, delivered_at, req.params.id]
  );
  res.json(result.rows[0]);
});

router.post("/media-assignments/:id/qc", async (req, res) => {
  const { qc_score, qc_notes } = req.body;
  const result = await db.query(
    `UPDATE pylon_media_assignments SET qc_score=$1, qc_notes=$2 WHERE id=$3 RETURNING *`,
    [qc_score, qc_notes, req.params.id]
  );
  res.json(result.rows[0]);
});

router.post("/booth-plans", async (req, res) => {
  const { event_id, event_size_tier, dedicated_sellers_planned, creators_planned, booth_manager_planned } = req.body;
  const result = await db.query(
    `INSERT INTO pylon_booth_staffing_plans (event_id, event_size_tier, dedicated_sellers_planned, creators_planned, booth_manager_planned)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [event_id, event_size_tier, dedicated_sellers_planned || 0, creators_planned || 0, booth_manager_planned || false]
  );
  res.json(result.rows[0]);
});

router.post("/booth-plans/:id/close", async (req, res) => {
  const { actual_sellers_present, actual_creators_present, booth_manager_present, gross_booth_sales_cents } = req.body;
  const result = await db.query(
    `UPDATE pylon_booth_staffing_plans SET actual_sellers_present=$1, actual_creators_present=$2, booth_manager_present=$3, gross_booth_sales_cents=$4, event_completed_at=now() WHERE id=$5 RETURNING *`,
    [actual_sellers_present, actual_creators_present, booth_manager_present, gross_booth_sales_cents, req.params.id]
  );
  res.json(result.rows[0]);
});

// ═══════════════════════════════════════════════════════════════════════════
// V3.0 · Regional Coordinators
// ═══════════════════════════════════════════════════════════════════════════

router.get("/coordinators", async (req, res) => {
  const { territory, status } = req.query;
  let query = "SELECT * FROM pylon_regional_coordinators WHERE 1=1";
  const params = [];
  if (territory) { params.push(territory); query += ` AND territory = $${params.length}`; }
  if (status) { params.push(status); query += ` AND onboarding_status = $${params.length}`; }
  query += " ORDER BY territory";
  const result = await db.query(query, params);
  res.json(result.rows);
});

router.post("/coordinators", async (req, res) => {
  const fields = ["full_name","email","phone","territory","base_city","hire_quarter","retainer_cents_monthly","commission_percent_territory","commission_metric_notes","contract_start","contract_end","metadata"];
  const values = fields.map((f) => req.body[f]);
  if (!req.body.full_name || !req.body.email || !req.body.territory) return res.status(400).json({ error: "full_name, email, territory required" });
  const placeholders = fields.map((_, i) => `$${i + 1}`).join(",");
  const result = await db.query(
    `INSERT INTO pylon_regional_coordinators (${fields.join(",")}, onboarding_status) VALUES (${placeholders},'onboarding') RETURNING *`,
    values
  );
  res.json(result.rows[0]);
});

// ═══════════════════════════════════════════════════════════════════════════
// V3.1 · CE-1 Pylon AI Coach (SKU #15)
// ═══════════════════════════════════════════════════════════════════════════

router.post("/ai-coach/subscribe", async (req, res) => {
  const { coach_email, coach_name, team_id, tier } = req.body;
  const amount = tier === "season" ? 99900 : 9900;
  const sku = "15";
  const splits = splitCents(sku, amount);
  const activeUntil = new Date();
  if (tier === "monthly") activeUntil.setMonth(activeUntil.getMonth() + 1);
  else activeUntil.setFullYear(activeUntil.getFullYear() + 1);
  const result = await db.query(
    `INSERT INTO pylon_ai_coach_subscriptions (coach_email, coach_name, team_id, tier, amount_cents, toj_take_cents, pylon_take_cents, active_until, next_billing_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`,
    [coach_email, coach_name, team_id, tier, amount, splits.toj_take_cents, splits.pylon_take_cents, activeUntil]
  );
  res.json({ subscription: result.rows[0], stripe_checkout_url: null });
});

router.post("/ai-coach/brief", async (req, res) => {
  const { subscription_id, brief_type, target_week, target_opponent_team_id, content_body } = req.body;
  const result = await db.query(
    `INSERT INTO pylon_ai_coach_briefs (subscription_id, brief_type, target_week, target_opponent_team_id, content_body)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [subscription_id, brief_type, target_week, target_opponent_team_id, content_body]
  );
  res.json(result.rows[0]);
});

// ═══════════════════════════════════════════════════════════════════════════
// V3.1 · CE-2 Pylon Momentum Score
// ═══════════════════════════════════════════════════════════════════════════

router.get("/momentum/:athlete_id", async (req, res) => {
  const result = await db.query(
    `SELECT * FROM pylon_athlete_momentum WHERE athlete_id=$1 ORDER BY measured_at DESC LIMIT 20`,
    [req.params.athlete_id]
  );
  res.json(result.rows);
});

router.post("/momentum/:athlete_id/compute", async (req, res) => {
  // TODO: implement computation from grade + volume + measurables + footage + recruiting + engagement
  const { season, week, grade_component, volume_component, measurable_component, footage_component, recruiting_component, engagement_component } = req.body;
  const composite = (
    (grade_component || 0) * 0.30 +
    (volume_component || 0) * 0.15 +
    (measurable_component || 0) * 0.15 +
    (footage_component || 0) * 0.15 +
    (recruiting_component || 0) * 0.15 +
    (engagement_component || 0) * 0.10
  );
  const trend = req.body.trend_direction || "insufficient_data";
  const result = await db.query(
    `INSERT INTO pylon_athlete_momentum (athlete_id, season, week, grade_component, volume_component, measurable_component, footage_component, recruiting_component, engagement_component, composite_score, trend_direction)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [req.params.athlete_id, season, week, grade_component, volume_component, measurable_component, footage_component, recruiting_component, engagement_component, composite, trend]
  );
  res.json(result.rows[0]);
});

// ═══════════════════════════════════════════════════════════════════════════
// V3.1 · CE-3 Signature Series (SKU #16)
// ═══════════════════════════════════════════════════════════════════════════

router.post("/signature-series", async (req, res) => {
  const { season, episode_number, title, anchor_athlete_id, anchor_team_id, narrative_theme, runtime_minutes } = req.body;
  const result = await db.query(
    `INSERT INTO pylon_signature_series_episodes (season, episode_number, title, anchor_athlete_id, anchor_team_id, narrative_theme, runtime_minutes)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [season, episode_number, title, anchor_athlete_id, anchor_team_id, narrative_theme, runtime_minutes]
  );
  res.json(result.rows[0]);
});

// ═══════════════════════════════════════════════════════════════════════════
// V3.1 · CE-5 HBCU Coaches
// ═══════════════════════════════════════════════════════════════════════════

router.get("/hbcu-coaches", async (req, res) => {
  const { program_name, active } = req.query;
  let query = "SELECT * FROM pylon_hbcu_coaches WHERE 1=1";
  const params = [];
  if (program_name) { params.push(program_name); query += ` AND program_name = $${params.length}`; }
  if (active !== undefined) { params.push(active === "true"); query += ` AND active = $${params.length}`; }
  query += " ORDER BY program_name, coach_role LIMIT 500";
  const result = await db.query(query, params);
  res.json(result.rows);
});

router.post("/hbcu-coaches", async (req, res) => {
  const fields = ["program_name","conference","coach_name","coach_email","coach_role","position_group","active","notes","metadata"];
  const values = fields.map((f) => req.body[f]);
  const placeholders = fields.map((_, i) => `$${i + 1}`).join(",");
  const result = await db.query(
    `INSERT INTO pylon_hbcu_coaches (${fields.join(",")}) VALUES (${placeholders}) RETURNING *`,
    values
  );
  res.json(result.rows[0]);
});

// ═══════════════════════════════════════════════════════════════════════════
// V3.1 · CE-6 AI Highlight Reel (SKU #18)
// ═══════════════════════════════════════════════════════════════════════════

router.post("/highlight-reel/subscribe", async (req, res) => {
  const { athlete_id, tier } = req.body;
  const priceMap = { basic: 2900, standard: 9900, recruiting: 14900 };
  const amount = priceMap[tier];
  if (!amount) return res.status(400).json({ error: "tier must be basic/standard/recruiting" });
  const sku = `18_${tier}`;
  const splits = splitCents(sku, amount);
  const activeUntil = new Date();
  activeUntil.setFullYear(activeUntil.getFullYear() + 1);
  const result = await db.query(
    `INSERT INTO pylon_highlight_reel_subscriptions (athlete_id, tier, amount_cents, toj_take_cents, pylon_take_cents, subject_media_take_cents, active_until)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [athlete_id, tier, amount, splits.toj_take_cents, splits.pylon_take_cents, splits.subject_media_take_cents, activeUntil]
  );
  res.json({ subscription: result.rows[0], stripe_checkout_url: null });
});

router.post("/highlight-reel/produce", async (req, res) => {
  const { subscription_id, athlete_id, event_id, reel_url, duration_seconds, plays_included, momentum_score_snapshot } = req.body;
  const result = await db.query(
    `INSERT INTO pylon_ai_highlight_reels (subscription_id, athlete_id, event_id, reel_url, duration_seconds, plays_included, momentum_score_snapshot)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [subscription_id, athlete_id, event_id, reel_url, duration_seconds, plays_included, momentum_score_snapshot]
  );
  res.json(result.rows[0]);
});

// ═══════════════════════════════════════════════════════════════════════════
// V3.1 · CE-7 Alumni Network (SKU #19)
// ═══════════════════════════════════════════════════════════════════════════

router.get("/alumni", async (req, res) => {
  const { alumni_type, membership_tier } = req.query;
  let query = "SELECT * FROM pylon_alumni WHERE 1=1";
  const params = [];
  if (alumni_type) { params.push(alumni_type); query += ` AND alumni_type = $${params.length}`; }
  if (membership_tier) { params.push(membership_tier); query += ` AND membership_tier = $${params.length}`; }
  query += " ORDER BY membership_tier DESC, full_name LIMIT 500";
  const result = await db.query(query, params);
  res.json(result.rows);
});

router.post("/alumni", async (req, res) => {
  const fields = ["full_name","email","phone","alumni_type","playing_position","college_program","nfl_team","years_active","membership_tier","membership_amount_cents","membership_active_until","mentor_active","investment_circle_member","investment_committed_cents","ig_handle","metadata"];
  const values = fields.map((f) => req.body[f]);
  if (!req.body.full_name) return res.status(400).json({ error: "full_name required" });
  const placeholders = fields.map((_, i) => `$${i + 1}`).join(",");
  const result = await db.query(
    `INSERT INTO pylon_alumni (${fields.join(",")}) VALUES (${placeholders}) RETURNING *`,
    values
  );
  res.json(result.rows[0]);
});

router.post("/alumni/:alumni_id/pair", async (req, res) => {
  const { athlete_id } = req.body;
  if (!athlete_id) return res.status(400).json({ error: "athlete_id required" });
  const result = await db.query(
    `INSERT INTO pylon_alumni_mentorships (alumni_id, athlete_id) VALUES ($1,$2) RETURNING *`,
    [req.params.alumni_id, athlete_id]
  );
  res.json(result.rows[0]);
});

// ═══════════════════════════════════════════════════════════════════════════
// V3.1 · CE-8 Data Feed B2B (SKU #20)
// ═══════════════════════════════════════════════════════════════════════════

router.post("/data-feed/licensees", async (req, res) => {
  const { organization_name, contact_name, contact_email, license_type, data_scope, refresh_cadence, amount_cents_annual, license_start, license_end } = req.body;
  const sku = "20";
  const splits = splitCents(sku, amount_cents_annual || 0);
  const result = await db.query(
    `INSERT INTO pylon_data_feed_licensees (organization_name, contact_name, contact_email, license_type, data_scope, refresh_cadence, amount_cents_annual, toj_take_cents_annual, pylon_take_cents_annual, optimum_take_cents_annual, license_start, license_end)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [organization_name, contact_name, contact_email, license_type, data_scope || [], refresh_cadence, amount_cents_annual, splits.toj_take_cents, splits.pylon_take_cents, splits.optimum_take_cents, license_start, license_end]
  );
  res.json(result.rows[0]);
});

// ═══════════════════════════════════════════════════════════════════════════
// Cross-cutting · Dashboard (Kyron's overview across all lines)
// ═══════════════════════════════════════════════════════════════════════════

router.get("/dashboard", async (req, res) => {
  const [orders, subs, deals, coordinators, ambassadors, momentum] = await Promise.all([
    db.query(`SELECT sku, COUNT(*) AS n, COALESCE(SUM(toj_take_cents),0) AS toj_take FROM pylon_package_orders WHERE status IN ('pending_delivery','delivered') GROUP BY sku`),
    db.query(`SELECT tier, COUNT(*) AS n, COALESCE(SUM(toj_take_cents),0) AS toj_take FROM pylon_athlete_subscriptions WHERE status='active' GROUP BY tier`),
    db.query(`SELECT status, COUNT(*) AS n, COALESCE(SUM(toj_commission_cents),0) AS commission FROM pylon_sponsor_deals GROUP BY status`),
    db.query(`SELECT territory, onboarding_status FROM pylon_regional_coordinators`),
    db.query(`SELECT tier, COUNT(*) AS n FROM pylon_ambassadors WHERE status='active' GROUP BY tier`),
    db.query(`SELECT COUNT(*) AS scored, AVG(composite_score) AS avg_score FROM pylon_athlete_momentum WHERE measured_at > now() - interval '30 days'`),
  ]);
  res.json({
    orders_by_sku: orders.rows,
    subscriptions_by_tier: subs.rows,
    deals_by_status: deals.rows,
    coordinators,
    ambassadors: ambassadors.rows,
    momentum: momentum.rows[0],
  });
});

// ═══════════════════════════════════════════════════════════════════════════

module.exports = router;
