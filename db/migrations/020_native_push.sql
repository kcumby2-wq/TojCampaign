-- 020: Notifications for the iPhone app (APNs), next to web push.
--
-- push_subscriptions (019) held web-push devices only. The App Store version
-- of TOJ gets its notifications from Apple (APNs) instead, with a device
-- token and no p256dh/auth keys. One table for both:
--   kind      'web' (endpoint = the browser's push URL, p256dh + auth set)
--             'apns' (endpoint = 'apns:<device token>', p256dh/auth null)
--   apns_env  'production' or 'sandbox' — the APNs server that accepted this
--             token last (TestFlight and App Store builds are production;
--             builds run straight from Xcode are sandbox).
-- Service-role only, as before (RLS policy from 019 still applies).

alter table public.push_subscriptions add column if not exists kind text not null default 'web';
alter table public.push_subscriptions add column if not exists apns_env text;
alter table public.push_subscriptions alter column p256dh drop not null;
alter table public.push_subscriptions alter column auth drop not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'push_subscriptions_kind_check') then
    alter table public.push_subscriptions add constraint push_subscriptions_kind_check check (kind in ('web', 'apns'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'push_subscriptions_apns_env_check') then
    alter table public.push_subscriptions add constraint push_subscriptions_apns_env_check check (apns_env is null or apns_env in ('production', 'sandbox'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'push_subscriptions_keys_check') then
    alter table public.push_subscriptions add constraint push_subscriptions_keys_check check (kind <> 'web' or (p256dh is not null and auth is not null));
  end if;
end $$;
