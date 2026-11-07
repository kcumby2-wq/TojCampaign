# Subject Medias bookings

Every booking on subjectmedias.com lands in the TOJ app and alerts Kyron, with the creators who work that region.

## The flow

1. **A booking request.** The form on subjectmedias.com posts to the site's own `/api/book` function, which forwards it to `POST /api/sm/bookings` here with the shared secret and the visitor's address as Vercel saw it. It asks for the job (athlete, team or event; package; sport; event; date; city and state), the booker's contact, and a box confirming they're 18 or older (a parent or guardian when the athlete isn't). It never asks for an athlete's name; an athlete is a team and jersey number.
   If they claimed the homepage's **10% first-package offer**, the request says so (`offer: first10`), and so do the staff email and the app. Take the 10% off when you confirm.
2. **The booker's note.** The booker gets one email of their own: "we got your booking request", what they asked for, and that we reply within 24 hours and nothing is charged until then. It goes to an address someone typed, so it carries fixed words only (the package, a sport from the list, the date, the state, the offer), never a name, city, event name, team or notes. Replies go to `SM_HELP_EMAIL` (hello@subjectmedias.com).
3. **Paying for it.** A package's Buy button (photo, video or elite) opens the booking form set to pay now: the request is saved with `pay_now`, and the site takes the booker straight on to that package's Stripe payment link with the request's id. Their note waits: when the payment joins the request they get "thanks for booking" with what they paid; if they don't finish, staff follow up like any request (the staff alert says they went on to pay).
   **No payment yet.** A pay-now request with no payment in the app an hour on gets one reminder: their details are saved, we haven't received a payment, here's the checkout (the package's payment link with the request's id), already paid means all set (a payment can take a while to reach us), reply to talk. Fixed words only, like their note. The app shows "No payment yet" on the booking, and when the reminder went. Before any reminder, the app asks Stripe itself (`SM_STRIPE_READ_KEY`): a checkout completed since the request that names it, or comes from the same mailbox on a payment link, means no reminder. That covers a bank payment still clearing, a late or broken webhook, and a payment that never joined. No key, or no answer from Stripe, means no reminders. Never for a request more than two days old, one staff have moved past new, a game that's today or past (New York's day), a request this server didn't see arrive (it keeps who sent each pay-now request in memory, for the limits), or a booker whose mailbox has another booking that's paid, or newer.
4. **Details after a direct Buy.** Each payment link sends the buyer back to `https://www.subjectmedias.com/details?paid={CHECKOUT_SESSION_ID}` (set under the payment link's "After payment": redirect to your website), where the site asks about the game (date, city and state, sport, team and jersey, notes, the adult box). The site's `api/details.js` checks the payment with Stripe first, then posts it to `POST /api/sm/bookings/paid` with `details: true`. The webhook and the answers can arrive in either order. The buyer's answers win over what the checkout's own fields said; the webhook only fills what's missing; the answers count once; the checkout's leftover fields land in the notes once. Staff get an "Event details in" push and email. If the answers can't be added to the booking, staff get them by email instead. Only checkouts on the site's payment links count (`payment_link` set, never the marketplace's `sm_market` checkouts), and a bank payment that hasn't cleared gets its details link by email once it does.
5. **The alert.** Kyron (everyone on `ADMIN_EMAILS`) gets a push in the TOJ app and an email. The push names the job in fixed words only: the package, a sport from the form's list, the state and the date. The email adds the city and the booker's contact. Both list the active creators in the booking's region from the Pylon crew pool (same city first, then screened, then adults), plus creators with a live page of their own nearby.
6. **Staffing.** In the TOJ app: Today → Bookings. Call or email the booker, tap **Staff** next to a creator, then mark it delivered. Only an adult whose screening is current on the game's date can be staffed (the Pylon rule in `utils/gfs.js`: a contract, a background check and safety training within the year, and an age check). Youth creators show in the suggestions but work only beside a screened adult, which a booking doesn't have. A delivered or cancelled booking keeps its creator. Open bookings are new, contacted or offered.

If the database can't take a booking, form or paid, the email carries the whole booking instead, so it isn't lost. If email isn't set up either, the site shows the booker the email address to write to, and Stripe retries the webhook later.

## The site's counts

`subjectmedias.com` counts how often its pages are opened and how often people open the booking form, tap Buy or see the 10% offer: `POST /api/sm/site/count?e=…` (through the site's rewrite), kept as totals per day in New York time (`sm_site_counts`, migration 034). No cookie, no address kept, nothing about who. Counts add up in the server and go to the database about once a minute, one write per kind. Only browsers count, at most 40 times per visitor per 10 minutes and 5,000 times an hour per kind in all. The Bookings screen shows the last 7 and 30 days, with the requests, 10% claims and payments from the bookings themselves (`GET /api/sm/site/counts`, staff only).

## Going live in order

For the reminder: **migration 035**, then this app (or the other way round: before 035, a pay-now request is saved without its flag, the Bookings list reads the old columns, and the reminder waits, logging once). Then `SM_STRIPE_READ_KEY` on Render turns the reminder on.

Before that, migration 034 first, then this app, then the site:

1. **Migration 034** in Supabase. The app's new code writes and reads its columns: without it, form bookings fall back to email and the Bookings list fails.
2. **This app.** Older site code keeps working against it.
3. **The site** (`details-and-counts` on subjectmedias-site). Its booking form sends the 10% claim as `offer`, and its details page posts answers this app's `/paid` understands; against the old app the claim and the answers would be lost.

## Settings (Render, `toj-csv-app`)

| Variable | What it is |
|---|---|
| `SM_BOOKINGS_SECRET` | A random string of 24+ characters. The same value goes on the subjectmedias-site Vercel project. The form and the webhook both send it; without it here, the form refuses bookings. |
| `EMAIL_USER`, `EMAIL_PASS` | The Gmail account and app password that send the emails (the report emails use the same pair). Without them, or a sending service, alerts are push only and bookers get no note. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | A sending service instead of Gmail (Postmark: `smtp.postmarkapp.com`, port 587, the server token as user and password; Amazon SES: its SMTP endpoint and SMTP credentials). When these are set they win over Gmail. |
| `EMAIL_FROM` | The sender people see, like `Subject Medias <hello@subjectmedias.com>`. A sending service needs it, and needs it verified (the domain's DNS records). |
| `EMAIL_REPLY_TO` | Where replies go when an email doesn't say. The booker's note always says `SM_HELP_EMAIL`. |
| `MAIL_DAILY_LIMIT` | Recipients a day across everything the app sends (400 on Gmail, whose limit is 500; 5000 through a service). Ordinary mail stops at five sixths of it; mail that must go (a booking the database couldn't take) can use the rest. Counted in memory, so a restart starts it again. |
| `SM_HELP_EMAIL`, `SM_SITE_BASE` | The address bookers and families write to (default hello@subjectmedias.com), and the site's address for links (default https://www.subjectmedias.com). |
| `SM_STRIPE_READ_KEY` | A live Stripe restricted key with Checkout Sessions: Read only (`rk_live_…`; the site's `STRIPE_SECRET_KEY` can be the same key). The reminder asks Stripe with it before each run; without it, or with a test key, no reminders go. |
| `SM_CHECKOUT_REMINDERS` | `off` stops the reminder even with the key set. |
| `APP_BASE` | The TOJ app's address for links in emails and Stripe onboarding returns. Defaults to `https://tojcampaign.com`. |
| `CREATOR_PAGE_BASE` | Where creator pages live publicly. Set to `https://www.subjectmedias.com` once the site's `/c/` rewrite is live; tojcampaign.com/c/… keeps working either way. |

## Rules

- The two POSTs take only the site's calls (the shared secret, compared by hash).
- The form allows 8 bookings per visitor per 10 minutes and 120 an hour in all, and drops anything that fills the hidden field. The details form shares those limits. Staff alert emails stop at 30 an hour; pushes still go and every booking is saved.
- Staff alert emails stop at 30 an hour and 100 a day (pushes still go).
- The booker's note goes once per booking (`booker_emailed_at`, claimed before sending), at most twice a day to one mailbox (Gmail's dots and +tags count as one), 3 a day from one visitor, and 30 an hour and 100 a day in all, so the form can't fill anyone's inbox or use up the Gmail account's daily sending. A note that couldn't go gives its place back and isn't retried by itself; the booking shows whether it went.
- Bookings are owner and staff only (`requireStaff`). The list never carries contact details or notes.
- Migration 034 adds `offer`, `details_at` and `booker_emailed_at`, and the site's counts (callable by the server only).
- Migration 035 adds `pay_now` (a form request only) and `checkout_reminded_at` (a pay-now request only). The reminder is claimed on the row before it goes (only while the request is unpaid, new and not reminded), so two servers send it once. Reminders have their own limits, apart from the booker's notes (so one never stops a "thanks for booking"): one a day to a mailbox, three a day from one visitor, 10 an hour, 30 a day, 10 a run. When the mailer can't send (the day's budget), the run stops and gives its claim back; a send that throws is tried at most three times. The link carries no email address.
- Migration 030 enforces the shape: a form booking needs the adult box and an email; a paid one needs its Stripe checkout; staffed and delivered need the creator, who then can't be deleted (pause them instead). Emails are plain addresses, so the Email button can't be made to copy anyone in. The API roles can't read the table.
