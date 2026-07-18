-- 008_pylon_partnership.sql
-- Pylon × TOJ Partnership · full schema across V2, V2.5, V2.7, V2.8, V2.9, V3.0, V3.1
-- Apply via Supabase MCP to project rgqvbmxnkybugfqfaubc AFTER Kyron confirms.
-- Do not apply if project ID differs.

-- ═══════════════════════════════════════════════════════════════════════════
-- V2 CORE · Teams, Athletes, Events, Registrations, Package Orders, Subscriptions
-- ═══════════════════════════════════════════════════════════════════════════

create table pylon_teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  program text,
  region text,                                     -- 'northeast' | 'southeast' | 'midwest' | 'south_central' | 'west' | 'international'
  division text,                                   -- 'HS Varsity' | 'Youth 12U' | 'Flag Girls 18U' | etc
  coach_name text,
  coach_email text,
  coach_phone text,
  first_registered_at timestamptz,
  active_season int,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index pylon_teams_region_idx on pylon_teams(region);
create index pylon_teams_active_season_idx on pylon_teams(active_season);

create table pylon_athletes (
  id uuid primary key default gen_random_uuid(),
  canonical_name text not null,
  team_id uuid references pylon_teams(id) on delete set null,
  parent_email text,
  parent_phone text,
  position text,
  class_year int,
  height_in int,
  weight_lb int,
  headshot_url text,
  prospect_edge_profile_url text,
  consent_public_stats boolean default false,
  guardian_signed_release_on_file boolean default false,
  represented boolean default false,               -- V2.5 · flag for Pylon Path anchor casting
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index pylon_athletes_team_idx on pylon_athletes(team_id);
create index pylon_athletes_class_year_idx on pylon_athletes(class_year);
create index pylon_athletes_represented_idx on pylon_athletes(represented) where represented = true;

create table pylon_events (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  event_type text not null default 'tournament',   -- tournament | league | camp | showcase | girls_flag | hbcu_showcase | live_draft | pylon_japan
  season int not null,
  start_date date not null,
  end_date date,
  city text,
  state text,
  country text default 'US',
  currency text default 'USD',
  team_cap int,
  region text,                                     -- V3.0 territorial regional
  event_size_tier text,                            -- V2.9 · 'small' | 'mid' | 'large'
  is_international boolean default false,
  team_inn_booking_url text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index pylon_events_season_idx on pylon_events(season, start_date);
create index pylon_events_region_idx on pylon_events(region);

create table pylon_registrations (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references pylon_teams(id),
  event_id uuid not null references pylon_events(id),
  registration_status text default 'confirmed',
  base_fee_paid_cents int,
  registered_at timestamptz not null default now(),
  unique(team_id, event_id)
);

create table pylon_package_orders (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid references pylon_registrations(id) on delete set null,
  team_id uuid references pylon_teams(id),
  athlete_id uuid references pylon_athletes(id),
  sku text not null,                               -- '1a' | '1b' | '1c' | '2' | '3' | '10' | '12' | '13' | '14' | '18-basic' | '18-standard' | '18-recruiting'
  amount_cents int not null,
  currency text default 'USD',
  toj_take_cents int not null,
  optimum_take_cents int default 0,
  subject_media_take_cents int default 0,
  pylon_take_cents int default 0,
  crew_type text,                                  -- 'mentorship' | 'contract'
  assigned_creator_email text,                     -- V2.9
  delivery_urls text[] default '{}',               -- V2.9
  status text default 'pending_delivery',
  paid_at timestamptz,
  delivered_at timestamptz,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index pylon_package_orders_status_idx on pylon_package_orders(status, created_at desc);
create index pylon_package_orders_team_idx on pylon_package_orders(team_id);
create index pylon_package_orders_athlete_idx on pylon_package_orders(athlete_id);
create index pylon_package_orders_sku_idx on pylon_package_orders(sku);

create table pylon_athlete_subscriptions (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid not null references pylon_athletes(id) on delete cascade,
  tier text not null,                              -- 'individual' | 'combine'
  amount_cents int not null,
  currency text default 'USD',
  toj_take_cents int not null,
  pylon_take_cents int default 0,
  optimum_take_cents int default 0,
  active_from timestamptz not null default now(),
  active_until timestamptz not null,
  next_billing_at timestamptz,
  status text default 'active',                    -- active | past_due | cancelled | expired
  stripe_subscription_id text,
  prospect_edge_profile_url text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index pylon_athlete_subscriptions_active_idx
  on pylon_athlete_subscriptions(athlete_id) where status = 'active';
create index pylon_athlete_subscriptions_next_billing_idx
  on pylon_athlete_subscriptions(next_billing_at) where status = 'active';

-- ═══════════════════════════════════════════════════════════════════════════
-- V2 CORE · Sponsors, Email Campaigns, Merch, City Leagues, Sequences, Live Posts
-- ═══════════════════════════════════════════════════════════════════════════

create table pylon_sponsors (
  id uuid primary key default gen_random_uuid(),
  company_name text not null,
  contact_name text,
  contact_email text,
  contact_phone text,
  region text,
  category text,                                   -- 'nutrition' | 'apparel' | 'auto' | 'local_food' | etc
  created_at timestamptz not null default now()
);

create table pylon_sponsor_deals (
  id uuid primary key default gen_random_uuid(),
  sponsor_id uuid not null references pylon_sponsors(id),
  event_id uuid references pylon_events(id),
  tier text not null,                              -- 'field' | 'team_presenting' | 'content' | 'email_campaign' | 'signature_series_episode' | 'signature_series_season' | 'hbcu_showcase' | 'alumni_content' | 'ambassador_slot'
  amount_cents int not null,
  toj_commission_cents int not null,
  status text default 'pending',                   -- pending | signed | invoiced | paid | delivered
  contract_start date,
  contract_end date,
  impressions_report_url text,
  closed_by text,
  category_exclusivity boolean default false,
  created_at timestamptz not null default now()
);
create index pylon_sponsor_deals_status_idx on pylon_sponsor_deals(status);

create table pylon_email_campaigns (
  id uuid primary key default gen_random_uuid(),
  sponsor_deal_id uuid references pylon_sponsor_deals(id),
  campaign_name text not null,
  subject_line text,
  send_at timestamptz,
  segment text,                                    -- 'all_teams' | 'coaches_only' | 'families' | 'girls_flag' | 'hbcu_interest' | 'alumni' | etc
  audience_count int,
  opens int default 0,
  clicks int default 0,
  conversions int default 0,
  report_url text,
  status text default 'draft',
  created_at timestamptz not null default now()
);

create table pylon_merch_drops (
  id uuid primary key default gen_random_uuid(),
  drop_type text not null,                         -- 'team' | 'event' | 'athlete_name'
  team_id uuid references pylon_teams(id),
  event_id uuid references pylon_events(id),
  athlete_id uuid references pylon_athletes(id),
  name text not null,
  storefront_url text,
  opens_at timestamptz,
  closes_at timestamptz,
  gross_revenue_cents int default 0,
  toj_margin_cents int default 0,
  status text default 'draft',
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table pylon_city_league_hosts (
  id uuid primary key default gen_random_uuid(),
  host_name text not null,
  city text not null,
  region text,
  contact_name text,
  contact_email text,
  contact_phone text,
  league_format text,                              -- 'flag_5v5' | '7v7' | 'both'
  toolkit_tier text default 'standard',            -- 'standard' | 'premium'
  toolkit_amount_cents int,
  toj_take_cents int,
  season int,
  ownership_model text default 'toolkit_license',  -- V3.1 · 'toolkit_license' | 'toj_owned_franchise'
  status text default 'onboarding',
  created_at timestamptz not null default now()
);

create table pylon_sales_sequences (
  id uuid primary key default gen_random_uuid(),
  sequence_key text unique not null,
  phase text not null,                             -- 'pre' | 'during' | 'post'
  trigger_condition jsonb,
  channel text not null,                           -- 'email' | 'sms' | 'push' | 'in_app_card'
  subject_template text,
  body_template text,
  cta_url_template text,
  active boolean default true,
  created_at timestamptz not null default now()
);

create table pylon_sequence_runs (
  id uuid primary key default gen_random_uuid(),
  sequence_id uuid not null references pylon_sales_sequences(id),
  team_id uuid references pylon_teams(id),
  athlete_id uuid references pylon_athletes(id),
  event_id uuid references pylon_events(id),
  fired_at timestamptz not null default now(),
  delivery_status text default 'sent',
  conversion_order_id uuid references pylon_package_orders(id) on delete set null,
  metadata jsonb default '{}'::jsonb
);
create index pylon_sequence_runs_team_idx on pylon_sequence_runs(team_id, fired_at desc);

create table pylon_live_posts (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references pylon_events(id),
  team_id uuid references pylon_teams(id),
  athlete_id uuid references pylon_athletes(id),
  post_type text not null,                         -- 'stat_card' | 'play_of_the_day' | 'athlete_of_the_half' | 'ranking_drop' | 'sponsor_bumper'
  asset_url text,
  channels text[],
  sponsor_tag text,
  posted_at timestamptz,
  engagement_metrics jsonb default '{}'::jsonb,
  operator text,
  created_at timestamptz not null default now()
);
create index pylon_live_posts_event_idx on pylon_live_posts(event_id, posted_at desc);

-- ═══════════════════════════════════════════════════════════════════════════
-- V2.5 · Content Ops · Pieces, Performance, Ambassadors, Newsletter
-- ═══════════════════════════════════════════════════════════════════════════

create table pylon_content_pieces (
  id uuid primary key default gen_random_uuid(),
  pillar text not null,                            -- 'ritual' | 'scale' | 'prestige' | 'capture'
  asset_type text not null,
  title text,
  primary_channel text not null,
  cross_post_channels text[] default '{}',
  scheduled_at timestamptz,
  published_at timestamptz,
  status text default 'draft',
  assigned_to text,
  approver text,
  sponsor_deal_id uuid references pylon_sponsor_deals(id) on delete set null,
  asset_url text,
  thumbnail_url text,
  copy_body text,
  cta_url text,
  athlete_ids uuid[] default '{}',
  team_ids uuid[] default '{}',
  event_id uuid references pylon_events(id) on delete set null,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index pylon_content_pieces_scheduled_idx on pylon_content_pieces(scheduled_at) where status in ('scheduled','approved');
create index pylon_content_pieces_pillar_idx on pylon_content_pieces(pillar, published_at desc);
create index pylon_content_pieces_status_idx on pylon_content_pieces(status);

create table pylon_content_performance (
  id uuid primary key default gen_random_uuid(),
  content_piece_id uuid not null references pylon_content_pieces(id) on delete cascade,
  measured_at timestamptz not null default now(),
  reach int default 0,
  impressions int default 0,
  likes int default 0,
  comments int default 0,
  shares int default 0,
  saves int default 0,
  clicks int default 0,
  conversions int default 0,
  conversion_revenue_cents int default 0,
  raw jsonb default '{}'::jsonb
);
create index pylon_content_performance_piece_idx on pylon_content_performance(content_piece_id, measured_at desc);

create table pylon_ambassadors (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid not null references pylon_athletes(id) on delete cascade,
  tier text default 'standard',                    -- 'standard' | 'featured' | 'flagship'
  monthly_stipend_cents int not null default 0,
  posts_expected_weekly int not null default 3,
  brand_affiliate_slots_monthly int default 4,
  ig_handle text,
  tiktok_handle text,
  twitter_handle text,
  youtube_channel text,
  follower_count_total int default 0,
  onboarded_at timestamptz,
  status text default 'active',                    -- 'active' | 'paused' | 'graduated' | 'removed' | 'applied' | 'applied_pending_review'
  contract_url text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index pylon_ambassadors_athlete_active_idx
  on pylon_ambassadors(athlete_id) where status = 'active';

create table pylon_ambassador_posts (
  id uuid primary key default gen_random_uuid(),
  ambassador_id uuid not null references pylon_ambassadors(id) on delete cascade,
  content_piece_id uuid references pylon_content_pieces(id) on delete set null,
  platform text not null,
  post_url text,
  posted_at timestamptz not null,
  amplified_by_pylon boolean default false,
  sponsor_integration_id uuid references pylon_sponsor_deals(id) on delete set null,
  reach int default 0,
  engagement int default 0,
  compliance_status text default 'compliant',
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index pylon_ambassador_posts_ambassador_idx on pylon_ambassador_posts(ambassador_id, posted_at desc);

create table pylon_newsletter_subscribers (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  first_name text,
  last_name text,
  tier text not null default 'free',               -- 'free' | 'premium'
  amount_cents int default 0,
  currency text default 'USD',
  stripe_subscription_id text,
  active_from timestamptz not null default now(),
  active_until timestamptz,
  status text default 'active',
  source text,
  team_id uuid references pylon_teams(id) on delete set null,
  athlete_id uuid references pylon_athletes(id) on delete set null,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index pylon_newsletter_subscribers_tier_idx on pylon_newsletter_subscribers(tier, status);
create index pylon_newsletter_subscribers_source_idx on pylon_newsletter_subscribers(source);

create table pylon_newsletter_issues (
  id uuid primary key default gen_random_uuid(),
  issue_number int unique not null,
  subject_line text not null,
  send_at timestamptz,
  free_body_html text,
  premium_body_html text,
  primary_sponsor_deal_id uuid references pylon_sponsor_deals(id) on delete set null,
  audience_free int default 0,
  audience_premium int default 0,
  opens_free int default 0,
  opens_premium int default 0,
  clicks int default 0,
  conversions int default 0,
  status text default 'draft',
  created_at timestamptz not null default now()
);

-- ═══════════════════════════════════════════════════════════════════════════
-- V2.7 · Recruiting Concierge (incl. HBCU premium tier)
-- ═══════════════════════════════════════════════════════════════════════════

create table pylon_recruiting_subscriptions (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid not null references pylon_athletes(id) on delete cascade,
  tier text not null,                              -- 'standard' | 'hbcu_premium' (V3.1 CE-5)
  billing_cadence text not null,                   -- 'monthly' | 'season'
  amount_cents int not null,
  currency text default 'USD',
  toj_take_cents int not null,
  pylon_take_cents int default 0,
  optimum_take_cents int default 0,
  active_from timestamptz not null default now(),
  active_until timestamptz not null,
  next_billing_at timestamptz,
  stripe_subscription_id text,
  target_college_list jsonb default '[]'::jsonb,
  hbcu_focus boolean default false,                -- V3.1 · HBCU pipeline flag
  status text default 'active',
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index pylon_recruiting_subscriptions_active_idx
  on pylon_recruiting_subscriptions(athlete_id) where status = 'active';

create table pylon_recruiting_outreach (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references pylon_recruiting_subscriptions(id) on delete cascade,
  athlete_id uuid not null references pylon_athletes(id),
  coach_name text,
  coach_email text,
  program_name text,
  program_level text,                              -- 'ncaa_d1' | 'ncaa_d2' | 'ncaa_d3' | 'naia' | 'juco' | 'hbcu'
  is_hbcu boolean default false,                   -- V3.1
  outreach_type text default 'intro',
  draft_subject text,
  draft_body text,
  parent_approved boolean default false,
  parent_approved_at timestamptz,
  sent_at timestamptz,
  coach_replied_at timestamptz,
  coach_reply_body text,
  reply_sentiment text,                            -- 'hot' | 'warm' | 'cold' | 'no_reply' | 'unsub'
  escalated_to_human boolean default false,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index pylon_recruiting_outreach_subscription_idx
  on pylon_recruiting_outreach(subscription_id, created_at desc);
create index pylon_recruiting_outreach_hot_idx
  on pylon_recruiting_outreach(reply_sentiment, escalated_to_human)
  where reply_sentiment = 'hot';

-- ═══════════════════════════════════════════════════════════════════════════
-- V2.8 · Creator referrals + Media assignments (V2.9)
-- ═══════════════════════════════════════════════════════════════════════════

create table pylon_creator_referrals (
  id uuid primary key default gen_random_uuid(),
  creator_email text not null,
  creator_name text not null,
  referral_code text unique not null,              -- e.g. 'JMILLER25'
  discount_percent int not null default 25,
  active_at_event_id uuid references pylon_events(id) on delete set null,
  active_from timestamptz not null default now(),
  active_until timestamptz,
  uses int default 0,
  tips_earned_cents int default 0,
  status text default 'active',
  created_at timestamptz not null default now()
);

create table pylon_referral_conversions (
  id uuid primary key default gen_random_uuid(),
  referral_id uuid not null references pylon_creator_referrals(id),
  package_order_id uuid not null references pylon_package_orders(id),
  attributed_at timestamptz not null default now()
);

create table pylon_media_assignments (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references pylon_events(id) on delete cascade,
  team_id uuid references pylon_teams(id) on delete set null,
  athlete_id uuid references pylon_athletes(id) on delete set null,
  creator_email text not null,
  creator_name text not null,
  content_taxonomy_slot text not null,             -- 'content_1' | 'content_2' | 'content_3a' | 'content_3b' | 'content_3c' | 'team_highlight'
  status text default 'assigned',                  -- 'assigned' | 'shot' | 'edited' | 'delivered' | 'reassigned'
  briefed_at timestamptz,
  shot_at timestamptz,
  delivered_at timestamptz,
  qc_score int,                                    -- 1-5 against Visual Direction rubric
  qc_notes text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index pylon_media_assignments_event_idx on pylon_media_assignments(event_id, status);
create index pylon_media_assignments_creator_idx on pylon_media_assignments(creator_email, briefed_at desc);

-- ═══════════════════════════════════════════════════════════════════════════
-- V2.9 · Booth staffing
-- ═══════════════════════════════════════════════════════════════════════════

create table pylon_booth_staffing_plans (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references pylon_events(id) on delete cascade,
  event_size_tier text not null,                   -- 'small' | 'mid' | 'large'
  dedicated_sellers_planned int default 0,
  creators_planned int default 0,
  booth_manager_planned boolean default false,
  actual_sellers_present int default 0,
  actual_creators_present int default 0,
  booth_manager_present boolean default false,
  gross_booth_sales_cents int default 0,
  planned_at timestamptz not null default now(),
  event_completed_at timestamptz
);
create index pylon_booth_staffing_plans_event_idx on pylon_booth_staffing_plans(event_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- V3.0 · Regional Coordinators
-- ═══════════════════════════════════════════════════════════════════════════

create table pylon_regional_coordinators (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text not null,
  phone text,
  territory text not null,                         -- 'northeast' | 'southeast' | 'midwest' | 'south_central' | 'west' | 'international_japan'
  base_city text,
  hire_quarter text,                               -- 'Q1_2026' | 'Q2_2026' | etc
  onboarding_status text default 'proposed',       -- 'proposed' | 'interviewing' | 'onboarding' | 'active' | 'inactive'
  retainer_cents_monthly int,                      -- V3.1 · retainer amount agreed with CEO
  commission_percent_territory numeric(5,2),       -- % of territory-attributable revenue
  commission_metric_notes text,                    -- owner-time-saved + revenue metrics
  contract_start date,
  contract_end date,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index pylon_regional_coordinators_territory_active_idx
  on pylon_regional_coordinators(territory) where onboarding_status = 'active';

-- ═══════════════════════════════════════════════════════════════════════════
-- V3.1 · CE-1 · Pylon AI Coach (SKU #15)
-- ═══════════════════════════════════════════════════════════════════════════

create table pylon_ai_coach_subscriptions (
  id uuid primary key default gen_random_uuid(),
  coach_email text not null,
  coach_name text not null,
  team_id uuid references pylon_teams(id) on delete set null,
  tier text not null,                              -- 'monthly' | 'season'
  amount_cents int not null,
  currency text default 'USD',
  toj_take_cents int not null,
  pylon_take_cents int default 0,
  active_from timestamptz not null default now(),
  active_until timestamptz not null,
  next_billing_at timestamptz,
  stripe_subscription_id text,
  status text default 'active',
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index pylon_ai_coach_subscriptions_active_idx
  on pylon_ai_coach_subscriptions(coach_email) where status = 'active';

create table pylon_ai_coach_briefs (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references pylon_ai_coach_subscriptions(id) on delete cascade,
  brief_type text not null,                        -- 'weekly_game_plan' | 'opponent_scouting' | 'practice_plan' | 'in_game_decision' | 'post_game_debrief'
  target_week int,
  target_opponent_team_id uuid references pylon_teams(id),
  generated_at timestamptz not null default now(),
  delivered_at timestamptz,
  content_body text,
  engagement_metrics jsonb default '{}'::jsonb,    -- opens, downloads, in-app time
  cartridge_pass_score int,                        -- pre-deliver eval score
  metadata jsonb default '{}'::jsonb
);
create index pylon_ai_coach_briefs_subscription_idx
  on pylon_ai_coach_briefs(subscription_id, generated_at desc);

-- ═══════════════════════════════════════════════════════════════════════════
-- V3.1 · CE-2 · Pylon Momentum Score
-- ═══════════════════════════════════════════════════════════════════════════

create table pylon_athlete_momentum (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid not null references pylon_athletes(id) on delete cascade,
  measured_at timestamptz not null default now(),
  season int not null,
  week int,
  grade_component numeric(5,2),                    -- Optimum on-field grade contribution 0-100
  volume_component numeric(5,2),                   -- Pylon event volume contribution
  measurable_component numeric(5,2),               -- measurables trend contribution
  footage_component numeric(5,2),                  -- footage volume contribution
  recruiting_component numeric(5,2),               -- recruiting momentum contribution
  engagement_component numeric(5,2),               -- engagement contribution
  composite_score numeric(5,2) not null,           -- final 0-100 score
  trend_direction text,                            -- 'rising' | 'stable' | 'declining' | 'insufficient_data'
  computation_notes text,
  metadata jsonb default '{}'::jsonb
);
create index pylon_athlete_momentum_athlete_idx
  on pylon_athlete_momentum(athlete_id, measured_at desc);
create index pylon_athlete_momentum_composite_idx
  on pylon_athlete_momentum(season, composite_score desc);

-- ═══════════════════════════════════════════════════════════════════════════
-- V3.1 · CE-3 · Pylon Signature Series (SKU #16) — episode tracking
-- ═══════════════════════════════════════════════════════════════════════════

create table pylon_signature_series_episodes (
  id uuid primary key default gen_random_uuid(),
  season int not null,
  episode_number int not null,
  title text not null,
  anchor_athlete_id uuid references pylon_athletes(id) on delete set null,
  anchor_team_id uuid references pylon_teams(id) on delete set null,
  narrative_theme text,
  runtime_minutes int,
  status text default 'concept',                   -- 'concept' | 'in_production' | 'in_edit' | 'approved' | 'published'
  presenting_sponsor_deal_id uuid references pylon_sponsor_deals(id) on delete set null,
  video_url text,
  premiere_date date,
  audience_reached int default 0,
  cartridge_pass_score int,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index pylon_signature_series_episodes_season_idx
  on pylon_signature_series_episodes(season, episode_number);

-- ═══════════════════════════════════════════════════════════════════════════
-- V3.1 · CE-5 · HBCU Pipeline · Coach directory
-- ═══════════════════════════════════════════════════════════════════════════

create table pylon_hbcu_coaches (
  id uuid primary key default gen_random_uuid(),
  program_name text not null,                      -- e.g. 'Grambling State', 'Jackson State', 'Howard'
  conference text,                                 -- 'SWAC' | 'MEAC' | 'independent'
  coach_name text not null,
  coach_email text,
  coach_role text,                                 -- 'head_coach' | 'oc' | 'dc' | 'positions' | 'recruiting_coordinator'
  position_group text,                             -- position they recruit for
  active boolean default true,
  last_interaction_at timestamptz,
  notes text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index pylon_hbcu_coaches_program_idx on pylon_hbcu_coaches(program_name, active);

-- ═══════════════════════════════════════════════════════════════════════════
-- V3.1 · CE-6 · Pylon AI Highlight Reel (SKU #18)
-- ═══════════════════════════════════════════════════════════════════════════

create table pylon_highlight_reel_subscriptions (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid not null references pylon_athletes(id) on delete cascade,
  tier text not null,                              -- 'basic' | 'standard' | 'recruiting'
  amount_cents int not null,
  currency text default 'USD',
  toj_take_cents int not null,
  pylon_take_cents int default 0,
  subject_media_take_cents int default 0,
  active_from timestamptz not null default now(),
  active_until timestamptz not null,
  stripe_subscription_id text,
  status text default 'active',
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index pylon_highlight_reel_subscriptions_active_idx
  on pylon_highlight_reel_subscriptions(athlete_id) where status = 'active';

create table pylon_ai_highlight_reels (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references pylon_highlight_reel_subscriptions(id) on delete cascade,
  athlete_id uuid not null references pylon_athletes(id),
  event_id uuid references pylon_events(id) on delete set null,
  produced_at timestamptz not null default now(),
  reel_url text,
  duration_seconds int,
  plays_included int,
  grade_informed_cuts boolean default true,
  momentum_score_snapshot numeric(5,2),
  distribution_status text default 'ready',        -- 'ready' | 'shared_to_socials' | 'sent_to_coaches' | 'archived'
  coach_targets uuid[] default '{}',               -- referenced pylon_recruiting_outreach ids for recruiting-tier
  metadata jsonb default '{}'::jsonb
);
create index pylon_ai_highlight_reels_subscription_idx
  on pylon_ai_highlight_reels(subscription_id, produced_at desc);

-- ═══════════════════════════════════════════════════════════════════════════
-- V3.1 · CE-7 · Pylon Alumni Network (SKU #19)
-- ═══════════════════════════════════════════════════════════════════════════

create table pylon_alumni (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text unique,
  phone text,
  alumni_type text not null,                       -- 'nfl' | 'd1_commit' | 'd2_commit' | 'juco_commit' | 'pro_other'
  playing_position text,
  college_program text,
  nfl_team text,
  years_active text,
  membership_tier text default 'associate',        -- 'associate' | 'active' | 'flagship'
  membership_amount_cents int default 0,
  membership_active_until timestamptz,
  mentor_active boolean default false,
  investment_circle_member boolean default false,
  investment_committed_cents int default 0,
  ig_handle text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index pylon_alumni_type_idx on pylon_alumni(alumni_type, membership_tier);

create table pylon_alumni_mentorships (
  id uuid primary key default gen_random_uuid(),
  alumni_id uuid not null references pylon_alumni(id) on delete cascade,
  athlete_id uuid not null references pylon_athletes(id) on delete cascade,
  paired_at timestamptz not null default now(),
  status text default 'active',                    -- 'active' | 'paused' | 'completed' | 'discontinued'
  last_touchpoint_at timestamptz,
  touchpoint_count int default 0,
  metadata jsonb default '{}'::jsonb
);
create index pylon_alumni_mentorships_alumni_idx on pylon_alumni_mentorships(alumni_id, status);

-- ═══════════════════════════════════════════════════════════════════════════
-- V3.1 · CE-8 · Pylon Data Feed B2B (SKU #20)
-- ═══════════════════════════════════════════════════════════════════════════

create table pylon_data_feed_licensees (
  id uuid primary key default gen_random_uuid(),
  organization_name text not null,
  contact_name text,
  contact_email text,
  license_type text not null,                      -- 'broadcaster' | 'gaming' | 'college_program' | 'fantasy'
  data_scope text[] default '{}',                  -- ['grade_data', 'stat_data', 'ranking_data', 'momentum_scores']
  refresh_cadence text,                            -- 'realtime' | 'daily' | 'weekly'
  amount_cents_annual int not null,
  toj_take_cents_annual int not null,
  pylon_take_cents_annual int default 0,
  optimum_take_cents_annual int default 0,
  license_start date,
  license_end date,
  api_key_hash text,
  status text default 'pending',                   -- 'pending' | 'active' | 'renewed' | 'expired'
  created_at timestamptz not null default now()
);
create index pylon_data_feed_licensees_status_idx on pylon_data_feed_licensees(status);

-- ═══════════════════════════════════════════════════════════════════════════
-- Migration metadata
-- ═══════════════════════════════════════════════════════════════════════════

-- Migration 008 · Pylon Partnership · full schema · V2 → V3.1 integrated
-- Tables created: 32
-- Indexes created: 27
-- Applied via Supabase MCP after Kyron confirms project id `rgqvbmxnkybugfqfaubc`
