# Subject Medias bookings

Every booking on subjectmedias.com lands in the TOJ app and alerts Kyron, with the creators who work that region.

## The flow

1. **A booking request.** The form on subjectmedias.com posts to `/api/book`, which the site's `vercel.json` rewrites to `POST /api/sm/bookings` here. It asks for the job (athlete, team or event; package; sport; event; date; city and state), the booker's contact, and a box confirming they're 18 or older (a parent or guardian when the athlete isn't). It never asks for an athlete's name; an athlete is a team and jersey number.
2. **A paid package.** The site's Stripe webhook (`api/stripe-webhook.js` on subjectmedias-site) posts the checkout to `POST /api/sm/bookings/paid` with the shared secret in `X-SM-Secret`. A webhook retry is a no-op.
3. **The alert.** Kyron (everyone on `ADMIN_EMAILS`) gets a push in the TOJ app and an email. The push names the job only. The email adds the booker's contact. Both list the active creators in the booking's region from the Pylon crew pool (same city first, then screened, then adults), plus creators with a live page of their own nearby.
4. **Staffing.** In the TOJ app: Today → Bookings. Call or email the booker, tap **Staff** next to a creator, then mark it delivered. Open bookings are new, contacted or offered.

If the database can't take a form booking, the email carries the whole booking instead, so it isn't lost. If email isn't set up either, the site shows the booker the email address to write to.

## Settings (Render, `toj-csv-app`)

| Variable | What it is |
|---|---|
| `SM_BOOKINGS_SECRET` | A random string of 24+ characters. The same value goes on the subjectmedias-site Vercel project. |
| `EMAIL_USER`, `EMAIL_PASS` | The Gmail account and app password that send the alert emails (the report emails use the same pair). Without them, alerts are push only. |
| `APP_BASE` | The TOJ app's address for links in emails and Stripe onboarding returns. Defaults to `https://tojcampaign.com`. |
| `CREATOR_PAGE_BASE` | Where creator pages live publicly. Set to `https://www.subjectmedias.com` once the site's `/c/` rewrite is live; tojcampaign.com/c/… keeps working either way. |

## Rules

- Bookings are owner and staff only (`requireStaff`). The list never carries contact details or notes.
- Migration 030 enforces the shape: a form booking needs the adult box; a paid one needs its Stripe checkout; staffed and delivered need the creator, who then can't be deleted (pause them instead). The API roles can't read the table.
- The public form allows 8 bookings per visitor address per 10 minutes, and drops anything that fills the hidden field.
