-- 014: Account roles no longer default to 'admin'.
--
-- Before this, /api/auth/register was open and every new row defaulted to
-- role 'admin', while the admin routes only checked "is someone signed in".
-- Staff access now needs the email on the ADMIN_EMAILS env allow-list AND a
-- role that wasn't self-registered (utils/staff.js).
--
-- users.role now means:
--   creator — self-registered (page builder). The new default.
--   client  — a client-portal login, set by staff (PATCH /api/admin/users/role).
--   staff   — set by staff. Admin access ALSO needs the email on ADMIN_EMAILS.
--   admin   — LEGACY: every account made before this change. Counts as staff
--             only if the email is on ADMIN_EMAILS; can open the client
--             portal so existing clients keep working. Review these rows by
--             hand and move each one to 'staff', 'client' or 'creator'.
--
-- The app already writes role 'creator' on sign-up, so the code fix does not
-- depend on this migration; this makes the database agree.
--
-- Not applied automatically. Kyron applies it after review.

alter table users alter column role set default 'creator';

alter table users drop constraint if exists users_role_check;
alter table users
  add constraint users_role_check check (role in ('creator', 'client', 'staff', 'admin'));

-- Review query (read only) — run this and look for any email you don't know:
--   select email, role, created_at from users order by created_at;
