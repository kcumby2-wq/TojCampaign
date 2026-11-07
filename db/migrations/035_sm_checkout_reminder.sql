-- 035: The follow-up for an unfinished checkout on a Subject Medias booking
-- (routes/sm-bookings.js, remindUnfinished).
--
-- On sm_bookings (migration 030), two columns, empty for the bookings already
-- there:
--   * pay_now: the request was sent from a package's Buy button (photo, video
--     or elite), and the site took the booker on to that package's Stripe
--     checkout. Until the payment joins the request, it isn't paid.
--   * checkout_reminded_at: when the booker of a pay-now request that wasn't
--     paid got the one reminder with their checkout link. Claimed before the
--     email goes, so it goes once.

alter table public.sm_bookings
  add column if not exists pay_now boolean not null default false,
  add column if not exists checkout_reminded_at timestamptz;

-- Only a form request goes on to pay from the site (a package bought from a
-- payment link is paid already), and only a pay-now request is reminded.
do $$ begin
  alter table public.sm_bookings add constraint sm_bookings_pay_now_form check (not pay_now or source = 'form');
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.sm_bookings add constraint sm_bookings_reminder_pay_now check (checkout_reminded_at is null or pay_now);
exception when duplicate_object then null; end $$;

-- The follow-up's question every few minutes: pay-now requests not paid and
-- not reminded yet, oldest first.
create index if not exists sm_bookings_unfinished_checkout
  on public.sm_bookings (created_at)
  where pay_now and stripe_session_id is null and checkout_reminded_at is null;
