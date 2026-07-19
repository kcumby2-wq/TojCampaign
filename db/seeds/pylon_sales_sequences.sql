-- pylon_sales_sequences.sql
-- Seeds the 12 canonical pre/during/post-event sales sequences.
-- Apply AFTER db/migrations/008_pylon_partnership.sql.
-- Every registered team runs through this cadence automatically.

INSERT INTO pylon_sales_sequences (sequence_key, phase, trigger_condition, channel, subject_template, body_template, cta_url_template, active) VALUES

-- ═══════════ PRE-EVENT · 5 touches, T-14 → T-1 ═══════════

('pre_event_t14', 'pre',
  '{"offset_days": -14, "from": "event.start_date"}'::jsonb,
  'email',
  'You''re registered for {{event_name}} — early-bird packages open',
  E'Coach,\n\nYou''re confirmed for {{event_name}}. Add Team Media Package now — early-bird pricing saves $50 vs event-day.\n\nRecap ($299) captures your event. Season Pack ($1,499) captures every event this season + Athlete Transcript per rostered player.\n\n{{cta_url}}\n\nPylon',
  'https://tojcampaign.com/pylon-team-packages.html?team_id={{team_id}}&event_id={{event_id}}',
  true),

('pre_event_t7', 'pre',
  '{"offset_days": -7, "from": "event.start_date"}'::jsonb,
  'email',
  '48 hours until packages lock — Combine Book unlocks college outreach',
  E'Coach,\n\nCombine Book ($2,999/season) grades every athlete on Optimum and delivers a printed book to you. That book puts every player in front of the Coaches Directory automatically.\n\nBook lives with you. Grades feed the Pylon Extended Rankings + Athlete Transcript for every kid on your roster.\n\n{{cta_url}}\n\nPylon',
  'https://tojcampaign.com/pylon-team-packages.html?team_id={{team_id}}&event_id={{event_id}}&sku=1c',
  true),

('pre_event_t3', 'pre',
  '{"offset_days": -3, "from": "event.start_date"}'::jsonb,
  'email',
  'Final add-on window — {{event_name}} media packages',
  E'Coach,\n\nFinal call. After tonight team media packages lock at event-day pricing.\n\nAdd Live Event Posting ($499/event standalone or bundled with Season Pack) to get real-time content pushed to your team + parent channels during games.\n\n{{cta_url}}\n\nPylon',
  'https://tojcampaign.com/pylon-team-packages.html?team_id={{team_id}}&event_id={{event_id}}',
  true),

('pre_event_t1', 'pre',
  '{"offset_days": -1, "from": "event.start_date"}'::jsonb,
  'sms',
  NULL,
  'Coach {{coach_name}} — Live Event Posting slots for {{event_name}} lock in 12 hours. Grab yours before Subject Media crew is maxed out: {{cta_url}}',
  'https://tojcampaign.com/pylon-team-packages.html?team_id={{team_id}}&event_id={{event_id}}&sku=10',
  true),

('pre_event_intake_reminder', 'pre',
  '{"offset_days": -2, "from": "event.start_date", "requires": "athlete_no_subscription"}'::jsonb,
  'email',
  'Parents — {{athlete_name}} at {{event_name}} this weekend',
  E'Parent,\n\n{{athlete_name}} is on the field this weekend at {{event_name}}. Your Athlete Transcript keeps every stat, every grade, every clip in one place — hosted at Prospect Edge, shareable with any coach.\n\n$99/season Individual · $249/season Combine (adds Optimum grading from every event).\n\n{{cta_url}}\n\nPylon',
  'https://tojcampaign.com/pylon-athlete-subscribe.html?athlete_id={{athlete_id}}',
  true),

-- ═══════════ DURING EVENT · 4 real-time triggers ═══════════

('during_event_stat_threshold', 'during',
  '{"stat.rec_yards": ">= 100", "OR": [{"stat.tds": ">= 2"}, {"stat.tackles_for_loss": ">= 3"}]}'::jsonb,
  'push',
  NULL,
  'See {{athlete_name}}''s live stats from {{event_name}} — unlock full season Athlete Transcript. {{cta_url}}',
  'https://tojcampaign.com/pylon-athlete-subscribe.html?athlete_id={{athlete_id}}&tier=combine',
  true),

('during_event_ranking_movement', 'during',
  '{"team_ranking_delta_abs": ">= 3"}'::jsonb,
  'email',
  '{{team_name}} moved to #{{ranking}} in Pylon Power Rankings',
  E'Coach,\n\n{{team_name}} just moved to #{{ranking}} in Pylon Power Rankings — a delta from the last drop.\n\nCement it. Combine Book ($2,999/season) turns this ranking into a printed record for every athlete on your roster.\n\n{{cta_url}}\n\nPylon',
  'https://tojcampaign.com/pylon-team-packages.html?team_id={{team_id}}&sku=1c',
  true),

('during_event_athlete_of_half', 'during',
  '{"card_type": "athlete_of_the_half", "posted_via": "live_console"}'::jsonb,
  'sms',
  NULL,
  '{{athlete_name}} is Athlete of the Half at {{event_name}}. Full season coverage from $99: {{cta_url}}',
  'https://tojcampaign.com/pylon-athlete-subscribe.html?athlete_id={{athlete_id}}',
  true),

('during_event_play_of_day', 'during',
  '{"card_type": "play_of_the_day", "posted_via": "live_console"}'::jsonb,
  'push',
  NULL,
  '{{team_name}} — Play of the Day. Share your team''s full recap: {{cta_url}}',
  'https://tojcampaign.com/pylon-team-packages.html?team_id={{team_id}}&sku=1a',
  true),

-- ═══════════ POST-EVENT · 3 touches, T+1 → T+14 ═══════════

('post_event_t1', 'post',
  '{"offset_days": 1, "from": "event.end_date"}'::jsonb,
  'email',
  'Your recap reel — {{event_name}}',
  E'Coach,\n\nYour recap reel from {{event_name}} is ready. Preview: {{cta_url}}\n\nSeason Pack ($1,499) captures this same quality every event this season + delivers Athlete Transcripts to every rostered player before final rankings drop.\n\nPylon',
  'https://tojcampaign.com/pylon-team-packages.html?team_id={{team_id}}&sku=1b',
  true),

('post_event_t7', 'post',
  '{"offset_days": 7, "from": "event.end_date"}'::jsonb,
  'email',
  'Rankings dropped — {{team_name}} moved to #{{ranking}}',
  E'Coach,\n\nRankings dropped. {{team_name}} is at #{{ranking}}. See the ranking-drop card + your Combine Book preview: {{cta_url}}\n\nEvery rostered athlete gets graded on Optimum + delivered in a printed book at season end.\n\nPylon',
  'https://tojcampaign.com/pylon-team-packages.html?team_id={{team_id}}&sku=1c',
  true),

('post_event_t14', 'post',
  '{"offset_days": 14, "from": "event.end_date"}'::jsonb,
  'email',
  'Next up — {{next_event_name}}',
  E'Coach,\n\nNext event: {{next_event_name}} at {{next_event_venue}}. Registration open. Media package pre-buy is live.\n\n{{cta_url}}\n\nPylon',
  'https://tojcampaign.com/pylon-team-packages.html?team_id={{team_id}}&event_id={{next_event_id}}',
  true)

ON CONFLICT (sequence_key) DO NOTHING;
