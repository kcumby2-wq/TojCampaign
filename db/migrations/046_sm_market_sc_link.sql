-- 046: a marketplace event's storefront on SportsClippers, Subject Medias'
-- exclusive distribution partner (Kyron, Nov 18). An approver pastes it on
-- the event in the TOJ app; the clips page and family links show it once it's
-- set, and nothing shows while it's empty. Like a Pylon stop's link (025), it
-- must be on sportsclippers.com, so nobody can point a family page anywhere
-- else. Safe to run twice.
alter table public.sm_market_events add column if not exists sportsclippers_url text;
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'sm_market_events_sportsclippers_url_chk'
                    and conrelid = 'public.sm_market_events'::regclass) then
    alter table public.sm_market_events add constraint sm_market_events_sportsclippers_url_chk
      check (sportsclippers_url is null
             or (char_length(sportsclippers_url) <= 300
                 and sportsclippers_url ~ '^https://([a-z0-9-]+\.)*sportsclippers\.com(/[^\s"<>]*)?$'));
  end if;
end $$;
