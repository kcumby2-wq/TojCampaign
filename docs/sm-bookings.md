# Subject Medias bookings

Every booking on subjectmedias.com lands in the TOJ app and alerts Kyron, with the creators who work that region.

## The flow

1. **A booking request.** The form on subjectmedias.com posts to the site's own `/api/book` function, which forwards it to `POST /api/sm/bookings` here with the shared secret and the visitor's address as Vercel saw it. It asks for the job (athlete, team or event; package; sport; event; date; city and state), the booker's contact, and a box confirming they're 18 or older (a parent or guardian when the athlete isn't). It never asks for an athlete's name; an athlete is a team and jersey number.
2. **Paying for it.** The success panel's pay button opens that package's Stripe payment link with the request's id (`client_reference_id`) and the booker's email filled in. The site's Stripe webhook (`api/stripe-webhook.js` on subjectmedias-site) posts the checkout to `POST /api/sm/bookings/paid`, and the payment joins the request. A package bought straight from a payment link is a booking of its own. A webhook retry is a no-op.
3. **The alert.** Kyron (everyone on `ADMIN_EMAILS`) gets a push in the TOJ app and an email. The push names the job in fixed words only: the package, a sport from the form's list, the state and the date. The email adds the city and the booker's contact. Both list the active creators in the booking's region from the Pylon crew pool (same city first, then screened, then adults), plus creators with a live page of their own nearby.
4. **Staffing.** In the TOJ app: Today → Bookings. Call or email the booker, tap **Staff** next to a creator, then mark it delivered. Only an adult whose screening is current on the game's date can be staffed (the Pylon rule in `utils/gfs.js`: a contract, a background check and safety training within the year, and an age check). Youth creators show in the suggestions but work only beside a screened adult, which a booking doesn't have. A delivered or cancelled booking keeps its creator. Open bookings are new, contacted or offered.

If the database can't take a booking, form or paid, the email carries the whole booking instead, so it isn't lost. If email isn't set up either, the site shows the booker the email address to write to, and Stripe retries the webhook later.

## Settings (Render, `toj-csv-app`)

| Variable | What it is |
|---|---|
| `SM_BOOKINGS_SECRET` | A random string of 24+ characters. The same value goes on the subjectmedias-site Vercel project. The form and the webhook both send it; without it here, the form refuses bookings. |
| `EMAIL_USER`, `EMAIL_PASS` | The Gmail account and app password that send the alert emails (the report emails use the same pair). Without them, alerts are push only. |
| `APP_BASE` | The TOJ app's address for links in emails and Stripe onboarding returns. Defaults to `https://tojcampaign.com`. |
| `CREATOR_PAGE_BASE` | Where creator pages live publicly. Set to `https://www.subjectmedias.com` once the site's `/c/` rewrite is live; tojcampaign.com/c/… keeps working either way. |

## Rules

- The two POSTs take only the site's calls (the shared secret, compared by hash).
- The form allows 8 bookings per visitor per 10 minutes and 120 an hour in all, and drops anything that fills the hidden field. Staff alert emails stop at 30 an hour; pushes still go and every booking is saved.
- Bookings are owner and staff only (`requireStaff`). The list never carries contact details or notes.
- Migration 030 enforces the shape: a form booking needs the adult box and an email; a paid one needs its Stripe checkout; staffed and delivered need the creator, who then can't be deleted (pause them instead). Emails are plain addresses, so the Email button can't be made to copy anyone in. The API roles can't read the table.
