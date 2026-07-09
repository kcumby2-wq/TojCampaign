# Supabase setup — the 15-minute pack

**Audience:** Kyron (Founder). Do this once. Then the whole SaaS stack is
armed and the CPO can move.
**Time:** 15 minutes end-to-end.

---

## What Supabase gives us

- **Postgres database** — the same DB Phase 2/3 SaaS will run on. No migration later.
- **Auth** — email/password + magic link + Google OAuth. Clients log into the portal with this.
- **Storage** — for Operational Transcript PDFs and client deliverables.
- **Row-Level Security (RLS)** — clients can only see their own data. The migration file already sets this up.
- **Realtime** — for future portal features (e.g. "new deliverable landed" toast).

Free tier is plenty for Phase 1 pilots. Pro tier ($25/mo) kicks in when we cross ~50K MAU.

---

## Step 1 — Create the project (5 min)

1. Go to **https://supabase.com** → **Start your project** → sign in with GitHub.
2. Create a new organization: **Trail of Joy Management Group**.
3. Create a new project inside it:
   - **Name:** `toj-production`
   - **Database password:** generate a strong one, save to 1Password
   - **Region:** `us-east-1` (or whatever's closest to Render — Ohio if Render's on US East)
   - **Plan:** Free (upgrade to Pro when we cross 50K MAU or need daily backups)
4. Wait ~2 minutes for the project to provision.

## Step 2 — Run the schema (2 min)

1. In the Supabase dashboard, left sidebar → **SQL Editor** → **New query**.
2. Open `db/migrations/001_initial_schema.sql` in this repo. Copy the whole file.
3. Paste into the SQL Editor. Click **Run**.
4. Confirm: left sidebar → **Table Editor** should now list `waitlist`, `clients`, `foundation_scores`, `deliverables`, `pilots`.

## Step 3 — Grab the credentials (2 min)

1. Left sidebar → **Project Settings** → **API**.
2. Copy these three values and save to 1Password:
   - **Project URL** (looks like `https://xxxxxxxxxxxx.supabase.co`)
   - **anon public key** (starts with `eyJ...`) — safe to expose in browser code
   - **service_role secret key** (also starts with `eyJ...`) — **NEVER expose in browser code**

## Step 4 — Paste creds into Render + Vercel (5 min)

### Render (Express backend — app.tojcampaign.com)

1. Render dashboard → your Express service → **Environment**.
2. Add these three variables:
   ```
   SUPABASE_URL=<Project URL>
   SUPABASE_SERVICE_ROLE_KEY=<service_role secret>
   SUPABASE_ANON_KEY=<anon public>
   ```
3. Save. Render auto-redeploys.

### Vercel (static marketing site — tojcampaign.com)

1. Vercel dashboard → `toj-campaign-noxn` project → **Settings** → **Environment Variables**.
2. Add these two (do **not** add the service_role key here — it must never ship to a browser):
   ```
   NEXT_PUBLIC_SUPABASE_URL=<Project URL>
   NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon public>
   ```
   (The `NEXT_PUBLIC_` prefix is only needed if we later move to Next.js. For now the client-side JS reads these from window-injected values via a tiny build step, or hardcodes them since anon key is safe to expose.)
3. Trigger a redeploy: **Deployments** → three-dot menu on latest → **Redeploy**.

## Step 5 — Verify (1 min)

From your terminal, with the anon key:

```bash
curl "https://<project-ref>.supabase.co/rest/v1/waitlist?select=count" \
  -H "apikey: <anon key>"
```

Should return `[{"count":0}]`. That means the DB is reachable and the RLS
policy for `anon` allows the read.

Then verify the waitlist endpoint on Render:

```bash
curl https://app.tojcampaign.com/api/waitlist/stats
```

Should return `{"total":0,"byVertical":{},"firstAt":null,"lastAt":null}`.

## Step 6 — Migrate the JSON waitlist (only if we have entries)

If any waitlist submissions came in before Supabase was hooked up, they're
in `db/waitlists.json` on the Render server. Migrate them:

1. SSH into Render or use their web console → `cat db/waitlists.json > /tmp/wl.json`
2. Paste each entry into the Supabase SQL Editor:
   ```sql
   insert into public.waitlist (email, vertical, source, meta, created_at)
   values
     ('a@example.com', 'personal-brand', '/personal-brand.html', '{}'::jsonb, '2026-07-08T12:00:00Z'),
     ('b@example.com', 'authority',      '/authority.html',       '{}'::jsonb, '2026-07-08T12:15:00Z');
   ```
3. Delete `db/waitlists.json` on Render to avoid double-writing.

## Once done

- The `routes/waitlist.js` code auto-detects `SUPABASE_URL`. If present, it writes to Postgres. If absent, it falls back to `db/waitlists.json`. This means you can safely do the migration without downtime.
- The admin dashboard at `/admin/waitlist.html` reads from whichever backend is active.
- The client portal at `/portal/` uses Supabase Auth for login.
- The CPO can start on the Foundation Score Supabase migration (`docs/foundation-score-supabase-spec.md`).

---

## Rollback / disaster plan

- **Delete a bad table:** SQL Editor → `drop table public.<name> cascade;` then re-run the migration.
- **Reset the whole DB:** Supabase dashboard → **Project Settings** → **Database** → **Reset database**. Then re-run the migration.
- **Total project loss:** the migration file lives in git. Create a new project, run it, paste new creds into Render/Vercel. Waitlist and pilots data would be lost, but everything else rebuilds from source.
- **Backup discipline:** turn on **Point-in-Time Recovery** once we're on the Pro tier ($25/mo). Until then, weekly `pg_dump` via the Supabase CLI as a cron job.

---

## What Kyron owes back

After running steps 1–4, message the CPO:

> Supabase is live. URL and anon key in 1Password shared vault under
> "TOJ / Supabase Production". Service role key restricted to me and
> Render env only. Migration 001 applied. All tables have RLS on.
> Ready for you to start on the Foundation Score refactor per
> `docs/foundation-score-supabase-spec.md`.
