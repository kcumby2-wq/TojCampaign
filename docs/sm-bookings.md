# Subject Medias bookings

Every booking on subjectmedias.com lands in the TOJ app and alerts Kyron, with the creators who work that region.

## The flow

1. **A booking request.** The form on subjectmedias.com posts to the site's own `/api/book` function, which forwards it to `POST /api/sm/bookings` here with the shared secret and the visitor's address as Vercel saw it. It asks for the job (athlete, team or event; package; sport; event; date; city and state), the booker's contact, and a box confirming they're 18 or older (a parent or guardian when the athlete isn't). It never asks for an athlete's name; an athlete is a team and jersey number.
   If they claimed the homepage's **10% first-package offer**, the request says so (`offer: first10`), and so do the staff email and the app. Take the 10% off when you confirm.
2. **The booker's note.** The booker gets one email of their own: "we got your booking request", what they asked for, and that we reply within 24 hours and nothing is charged until then. It goes to an address someone typed, so it carries fixed words only (the package, a sport from the list, the date, the state, the offer), never a name, city, event name, team or notes. Replies go to `SM_HELP_EMAIL` (hello@subjectmedias.com).
3. **Paying for it.** The success panel's pay button opens that package's Stripe payment link with the request's id (`client_reference_id`) and the booker's email filled in. The site's Stripe webhook (`api/stripe-webhook.js` on subjectmedias-site) posts the checkout to `POST /api/sm/bookings/paid`, and the payment joins the request (no second note: Stripe sends the receipt). A package bought straight from a payment link is a booking of its own, and the buyer's note says thanks, with a link to tell us about the game. A webhook retry is a no-op.
4. **Details after a direct Buy.** Each payment link sends the buyer back to `https://www.subjectmedias.com/details?paid={CHECKOUT_SESSION_ID}` (set under the payment link's "After payment": redirect to your website), where the site asks about the game (date, city and state, sport, team and jersey, notes, the adult box). The site's `api/details.js` checks the payment with Stripe first, then posts it to `POST /api/sm/bookings/paid` with `details: true`. The webhook and the answers can arrive in either order: whichever comes second fills in only what the booking doesn't have yet, and the answers count once. Staff get an "Event details in" push and email.
5. **The alert.** Kyron (everyone on `ADMIN_EMAILS`) gets a push in the TOJ app and an email. The push names the job in fixed words only: the package, a sport from the form's list, the state and the date. The email adds the city and the booker's contact. Both list the active creators in the booking's region from the Pylon crew pool (same city first, then screened, then adults), plus creators with a live page of their own nearby.
6. **Staffing.** In the TOJ app: Today → Bookings. Call or email the booker, tap **Staff** next to a creator, then mark it delivered. Only an adult whose screening is current on the game's date can be staffed (the Pylon rule in `utils/gfs.js`: a contract, a background check and safety training within the year, and an age check). Youth creators show in the suggestions but work only beside a screened adult, which a booking doesn't have. A delivered or cancelled booking keeps its creator. Open bookings are new, contacted or offered.

If the database can't take a booking, form or paid, the email carries the whole booking instead, so it isn't lost. If email isn't set up either, the site shows the booker the email address to write to, and Stripe retries the webhook later.

## The site's counts

`subjectmedias.com` counts how often its pages are opened and how often people open the booking form, tap Buy or see the 10% offer: `POST /api/sm/site/count?e=…` (through the site's rewrite), kept as totals per day in New York time (`sm_site_counts`, migration 034). No cookie, no address kept, nothing about who. Only browsers count, at most 40 times per visitor per 10 minutes. The Bookings screen shows the last 7 and 30 days, with the requests, 10% claims and payments from the bookings themselves (`GET /api/sm/site/counts`, staff only).

## Settings (Render, `toj-csv-app`)

| Variable | What it is |
|---|---|
| `SM_BOOKINGS_SECRET` | A random string of 24+ characters. The same value goes on the subjectmedias-site Vercel project. The form and the webhook both send it; without it here, the form refuses bookings. |
| `EMAIL_USER`, `EMAIL_PASS` | The Gmail account and app password that send the emails (the report emails use the same pair). Without them, or a sending service, alerts are push only and bookers get no note. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | A sending service instead of Gmail (Postmark: `smtp.postmarkapp.com`, port 587, the server token as user and password; Amazon SES: its SMTP endpoint and SMTP credentials). When these are set they win over Gmail. |
| `EMAIL_FROM` | The sender people see, like `Subject Medias <hello@subjectmedias.com>`. A sending service needs it, and needs it verified (the domain's DNS records). |
| `EMAIL_REPLY_TO` | Where replies go when an email doesn't say. The booker's note always says `SM_HELP_EMAIL`. |
| `SM_HELP_EMAIL`, `SM_SITE_BASE` | The address bookers and families write to (default hello@subjectmedias.com), and the site's address for links (default https://www.subjectmedias.com). |
| `APP_BASE` | The TOJ app's address for links in emails and Stripe onboarding returns. Defaults to `https://tojcampaign.com`. |
| `CREATOR_PAGE_BASE` | Where creator pages live publicly. Set to `https://www.subjectmedias.com` once the site's `/c/` rewrite is live; tojcampaign.com/c/… keeps working either way. |

## Rules

- The two POSTs take only the site's calls (the shared secret, compared by hash).
- The form allows 8 bookings per visitor per 10 minutes and 120 an hour in all, and drops anything that fills the hidden field. The details form shares those limits. Staff alert emails stop at 30 an hour; pushes still go and every booking is saved.
- The booker's note goes once per booking (`booker_emailed_at`, claimed before sending), at most twice a day to one address, and 30 an hour and 150 a day in all, so the form can't fill anyone's inbox or use up the Gmail account's daily sending.
- Bookings are owner and staff only (`requireStaff`). The list never carries contact details or notes.
- Migration 034 adds `offer`, `details_at` and `booker_emailed_at`, and the site's counts (callable by the server only).
- Migration 030 enforces the shape: a form booking needs the adult box and an email; a paid one needs its Stripe checkout; staffed and delivered need the creator, who then can't be deleted (pause them instead). Emails are plain addresses, so the Email button can't be made to copy anyone in. The API roles can't read the table.
