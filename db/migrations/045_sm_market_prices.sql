-- 045: the marketplace's starting prices match SportsClippers', Subject
-- Medias' exclusive distribution partner (Kyron, Nov 18): $19.99 a clip in HD
-- and $11.99 a photo, its flat rates for event footage. A new event starts
-- there, and staff can still change an event's prices on the event. Events
-- already made keep theirs (production had none on Nov 18). The app's own
-- default, utils/sm-market.js DEFAULT_PRICES, says the same. Safe to run twice.
alter table public.sm_market_events
  alter column clip_cents set default 1999,
  alter column photo_cents set default 1199;
