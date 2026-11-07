-- 034: More for Subject Medias bookings (routes/sm-bookings.js), and the
-- site's own counts (routes/sm-site.js).
--
-- On sm_bookings (migration 030), three columns, all empty for the bookings
-- already there:
--   * offer: 'first10' when the booker claimed the 10% first-package offer on
--     the homepage. Staff take the 10% off when they confirm the booking.
--   * details_at: when the buyer of a package bought straight from a payment
--     link told us about their game (the site's "Tell us about your event"
--     form after paying). Set once: a second answer changes nothing.
--   * booker_emailed_at: when the booker's own note went out (we got your
--     request, or thanks for booking). Claimed before sending, so it goes once.
--
-- sm_site_counts: how many times a day the homepage and the fellowship page
-- were opened, and how many times someone opened the booking form, tapped Buy
-- or saw the 10% offer. Totals per day (New York time) and nothing else: no
-- cookie, no address, no device, nothing about who. Requests sent, claims and
-- payments come from sm_bookings itself.
--
-- Service role only: RLS on, no policies, nothing granted to anon or
-- authenticated, and the counting function callable by the server only.

alter table public.sm_bookings
  add column if not exists offer text check (offer is null or offer in ('first10')),
  add column if not exists details_at timestamptz,
  add column if not exists booker_emailed_at timestamptz;

create table if not exists public.sm_site_counts (
  day date not null,
  name text not null check (name in ('visit_home', 'visit_fellowship', 'book_open', 'buy_tap', 'offer_shown')),
  n integer not null default 0 check (n >= 0),
  primary key (day, name)
);

-- One more for today. A day's count stops at a million, so a flood that gets
-- past the server's limits can't run it up forever.
create or replace function public.sm_site_count(p_name text) returns void
language sql volatile set search_path = '' as $$
  insert into public.sm_site_counts as c (day, name, n)
  values ((now() at time zone 'America/New_York')::date, p_name, 1)
  on conflict (day, name) do update set n = c.n + 1 where c.n < 1000000
$$;

alter table public.sm_site_counts enable row level security;
-- Callable by the server only (Supabase grants new functions to its API roles),
-- and the API roles get no table rights (a bare Postgres in tests has no roles).
revoke all on function public.sm_site_count(text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.sm_site_counts from anon;
    revoke all on function public.sm_site_count(text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.sm_site_counts from authenticated;
    revoke all on function public.sm_site_count(text) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.sm_site_count(text) to service_role;
  end if;
end $$;
