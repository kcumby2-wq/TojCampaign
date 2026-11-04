-- 032: Applications to the Subject Medias creator fellowship. Every creator who
-- applies on subjectmedias.com/fellowship lands here (routes/sm-fellowship.js;
-- the rules are in utils/sm-fellowship.js).
--
-- Each new application alerts staff (a push to the TOJ app and an email).
-- Kyron reviews it under Fellowship in the app, talks with the creator,
-- approves them and sends the payment link for their plan, then marks them
-- joined once they've paid and signed the creator agreement.
--
-- What it holds, and what it never does:
--   * The applicant's own name and contact, the city they're near, the seat
--     they want, the plan they lean toward, up to three links to their work,
--     their gear and what they wrote about themselves. Shown to staff in the
--     app; never on a public page. Plain addresses only, so a staff Email
--     button can't be made to copy anyone in.
--   * Applicants are 16 or older. At 16 or 17 a parent or guardian is on the
--     application (a name and an email that isn't the applicant's), and only
--     the seats open at 16 or 17 can be asked for: shadow, shooter,
--     photographer. An adult's application carries no guardian at all.
--   * Links are https only, with no sign-in details in them.
--   * One open application per email address (new, talking or approved).
--   * Service role only: RLS on, no policies, nothing granted to anon or
--     authenticated.

-- Up to three links, each an https address with a real host and nothing
-- before the @ (no sign-in details), 500 characters at most.
create or replace function public.sm_fellowship_links_ok(l text[]) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(
    array_ndims(l) = 1
    and cardinality(l) between 1 and 3
    and array_position(l, null) is null
    and (select bool_and(char_length(x) <= 500 and x ~ '^https://[^/@?#[:space:]]+\.[^/@?#[:space:]]+(/[^[:space:]]*)?$') from unnest(l) as x),
    false)
$$;

create table if not exists public.sm_fellowship_applications (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  email text not null check (
    email = lower(email) and char_length(email) between 3 and 200
    and email ~ '^[a-z0-9._+''-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$'),
  phone text check (phone is null or char_length(phone) between 7 and 30),
  -- An Instagram handle, for the credit line: lowercase, no @.
  handle text check (handle is null or handle ~ '^[a-z0-9._]{1,30}$'),
  city text not null check (char_length(city) between 1 and 80),
  state text not null check (state ~ '^[A-Z]{2}$'),
  region text check (region is null or region in ('west', 'south_central', 'northeast', 'southeast', 'midwest')),
  -- adult: 18 or older. teen: 16 or 17.
  age_group text not null check (age_group in ('adult', 'teen')),
  guardian_name text check (guardian_name is null or char_length(guardian_name) between 1 and 80),
  guardian_email text check (guardian_email is null or (
    guardian_email = lower(guardian_email) and char_length(guardian_email) between 3 and 200
    and guardian_email ~ '^[a-z0-9._+''-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$')),
  guardian_phone text check (guardian_phone is null or char_length(guardian_phone) between 7 and 30),
  seat text not null default 'unsure'
    check (seat in ('unsure', 'shadow', 'shooter', 'photographer', 'story', 'editor', 'lead')),
  plan text not null default 'unsure' check (plan in ('unsure', 'tools', 'meetings')),
  links text[] not null check (public.sm_fellowship_links_ok(links)),
  gear text check (gear is null or char_length(gear) <= 200),
  about text check (about is null or char_length(about) <= 1000),
  -- The applicant confirmed their age group and that the work is theirs.
  confirmed boolean not null default false check (confirmed),
  status text not null default 'new'
    check (status in ('new', 'talking', 'approved', 'joined', 'declined', 'withdrawn')),
  staff_note text check (staff_note is null or char_length(staff_note) <= 1000),
  status_by text check (status_by is null or char_length(status_by) <= 200),
  approved_at timestamptz,
  -- When the approval note with the payment link went out from the app.
  emailed_at timestamptz,
  alerted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sm_fellowship_teen_chk check (
    age_group = 'adult'
    or (guardian_name is not null and guardian_email is not null and guardian_email <> email)),
  constraint sm_fellowship_teen_seat_chk check (
    age_group = 'adult' or seat in ('unsure', 'shadow', 'shooter', 'photographer')),
  constraint sm_fellowship_adult_chk check (
    age_group = 'teen' or (guardian_name is null and guardian_email is null and guardian_phone is null)),
  constraint sm_fellowship_approved_chk check (status not in ('approved', 'joined') or approved_at is not null)
);

create index if not exists sm_fellowship_status_idx on public.sm_fellowship_applications (status, created_at desc);
create unique index if not exists sm_fellowship_open_email_idx on public.sm_fellowship_applications (email)
  where status in ('new', 'talking', 'approved');

alter table public.sm_fellowship_applications enable row level security;
-- RLS with no policies already shuts the API roles out; take their table
-- rights away too, where those roles exist (a bare Postgres in tests has none).
-- (The links check reads nothing but its argument, so anyone may call it.)
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on public.sm_fellowship_applications from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on public.sm_fellowship_applications from authenticated; end if;
end $$;
