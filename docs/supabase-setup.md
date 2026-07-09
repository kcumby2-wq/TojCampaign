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

Instead of running curls by hand, use the bundled verify script — it
checks all five tables, confirms RLS is doing its job, hits the Render
backend, and tells you exactly what's wrong if something isn't wired.

```bash
export SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
export SUPABASE_ANON_KEY=eyJ...
export SUPABASE_SERVICE_ROLE_KEY=eyJ...
node scripts/verify-supabase.mjs
```

Green checks across the board = you're done. Add `SKIP_RENDER=1` in front
if Render hasn't redeployed yet.

If any check fails, the script tells you exactly what to fix — usually a
mistyped key or a table you missed running the migration on.

## Step 6 — Migrate the JSON waitlist

**Current state (as of 2026-07-09):** `db/waitlists.json`, `db/clients.json`,
`db/foundation_scores.json`, `db/pilots.json` are all committed as empty
arrays. **Nothing to migrate.** Skip this step.

If waitlist / intake submissions land on Render *before* you finish the
Supabase setup, you'll want to bring them across. Ping me and I'll write
the migration script — one-shot, reads the JSON files, inserts to
Postgres, then deletes the local files. Takes 5 minutes.

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
