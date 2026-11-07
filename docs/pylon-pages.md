# The Pylon pages

The public Pylon pages on tojcampaign.com take real requests now. Each form saves a request, staff get a push and an email, and the person who sent it gets one note. When Pylon's Stripe is set up, the page goes straight on to a Stripe checkout at the server's price.

| Page | What it takes | Kind |
| --- | --- | --- |
| `/pylon-team-packages.html` | A coach books team coverage: Recap $299, Season Pack $1,499, Combine Book $2,999 | `team_package` |
| `/pylon-player-packages.html` | Coverage of one athlete at an event: Snapshot $69, Story $99, Feature $199 | `player_package` |
| `/pylon-athlete-subscribe.html` | The Athlete Transcript: Individual $99 or Combine $249 for the season | `transcript` |
| `/pylon-recruiting.html` | The Recruiting Concierge: Standard $99 a month or $499 a season, HBCU Premium $149 a month or $749 a season | `recruiting` |
| `/pylon-newsletter.html` | The free list (confirmed by email), and Premium at $9.99 a month | `newsletter_premium` |
| `/pylon-ambassadors.html` | An application for Standard, Featured or Flagship | `ambassador` |

The code: `routes/pylon.js` (the API), `utils/pylon.js` (prices, what each form must carry, the consent words, the emails), `utils/pylon-stripe.js` (Stripe), `public/pylon-forms.js` and `public/pylon-forms.css` (the pages' forms), `public/app/pylon.js` (the app screens), migration `036_pylon_requests.sql`.

## Who can send what

* A form about one athlete (player coverage, transcript, Concierge, ambassador) starts with "Who's filling this in?": the athlete's parent, the athlete's legal guardian, or the athlete at 18 or older. An athlete under 18 is asked to have their parent or guardian fill it in, and the form won't send.
* The person then ticks a box next to the exact words they're agreeing to. Those words are kept on the request as they were (`consent_text`), with who answered (`consent`). The database refuses an athlete on a request without both.
* Player coverage asks separately whether Pylon may also post the coverage on its own channels. Unticked, it's for the family only. The answer is part of the words on file.
* The Concierge's words say nothing goes to a coach until the parent approves the exact message.
* An ambassador application from a parent or guardian needs the parent's own email, not the athlete's (Gmail's dots and +tags count as the same mailbox). Nothing starts until they sign an agreement.
* A team booking names no athlete. The coach's note says we only post an athlete's footage publicly once their parent or guardian has said yes.

## Who sees it

Requests are for the owner (ADMIN_EMAILS, staff role), like the Subject Medias bookings: they hold minors' names and money. In the TOJ app: the **Pylon** tile on Today, or Tools → Pylon.

* `#pylon`: open requests (`#pylon/all` for every one).
* `#pylon-request/<id>`: who to call, the athlete, what they agreed to, payment, status (New, Contacted, Confirmed, Done, Closed) and a team note. "Paid another way" records a payment made outside Stripe (an invoice, cash); only that kind can be taken back. Refunds of Stripe payments happen in Stripe.
* `#pylon-newsletter`: the confirmed list, with a button to copy the addresses.

The staff push and email say what came in and link to the app. Names and contact details stay in the app. If the database can't take a request, the staff email carries all of it (it's then the only copy).

## Emails

| Who | When | Says |
| --- | --- | --- |
| The contact | The request comes in | We got it; what happens next; the payment line (checkout, or we'll send a link); what they agreed to; "Didn't send this? Reply and we'll delete it." |
| The contact | Stripe confirms a payment | Payment received; Stripe sends the receipt; how to cancel a monthly one |
| A newsletter address | Someone subscribes it | A link to confirm. Nothing else is sent until they do. Works for 7 days. |
| Staff | Each request, each payment | What and where, and the app link |

Replies go to `PYLON_HELP_EMAIL` (default hello@pylonfootball.com). The sender is the app's mail settings (EMAIL_FROM or the Gmail account), the same as every other email the app sends.

Limits, so the forms can't be used to fill anyone's inbox: 8 forms per visitor per 10 minutes and 120 an hour in all; contact notes at most 2 a day to one mailbox, 6 a day from one visitor, 30 an hour and 100 a day in all; one newsletter confirmation a day to one address; staff emails 30 an hour and 100 a day (the push always goes).

## Payments

Until the settings below are in, the pages say "Send request" and people hear we'll send a secure payment link. Staff send one (or mark it paid another way).

With them in, the button says "Continue to payment" and each request goes on to a Stripe checkout made by the server: the price from `utils/pylon.js`, the request's id on it, cards only. A monthly package (Concierge monthly, Newsletter Premium) is a Stripe subscription; everything else is one payment. Back from Stripe, the page says Stripe sends the receipt and we'll be in touch. The payment joins its request only when Stripe's signed webhook says so.

Creator codes: a player-package link with `?ref=CODE` shows the code and sends it with the request. If Stripe has an active promotion code by that name, the checkout applies it; otherwise the buyer can type one. The 25% off is the coupon behind the codes, set up in Stripe.

## Go-live settings (Render, toj-csv-app)

Pick the Stripe account that takes Pylon's payments (per the Pylon agreement). Then:

1. `PYLON_STRIPE_SECRET_KEY`: a restricted key on that account with **Checkout Sessions: Write** and **Promotion Codes: Read**. If a test checkout is refused for a missing permission, the server log says which; add it to the key. Start with a test key (`rk_test_…`).
2. In that Stripe account: Developers → Webhooks → add endpoint `https://tojcampaign.com/api/pylon/stripe/webhook`, event `checkout.session.completed`. Put its signing secret in `PYLON_STRIPE_WEBHOOK_SECRET`.
3. For creator codes: a 25%-off coupon, and a promotion code per creator under it.
4. Test: send a player request, pay with Stripe's test card, and check the request shows "Paid" in the app and the receipt note arrives.
5. Live: swap in the live restricted key, add the live webhook endpoint and its secret, and set `PYLON_STRIPE_LIVE=yes`. A live key does nothing without it.

Optional: `PYLON_HELP_EMAIL` (where replies go), `PYLON_SITE_BASE` (where the pages live, default https://tojcampaign.com; Stripe sends people back there).

## The newsletter list

`pylon_newsletter` holds each address once: pending, confirmed or unsubscribed. Only confirmed addresses are on the list. Every issue sent to the list must carry that address's unsubscribe link:

`https://tojcampaign.com/pylon-newsletter.html?unsubscribe=<unsubscribe_token>`

The page asks them to tap Unsubscribe (so an email scanner opening the link changes nothing), then takes the address off.

## What this replaced

The old design (migrations 008, 013 and 016, `routes/pylon.js` with about 60 endpoints, `routes/pylon-parent.js`, the sequence cron and six admin pages) never ran in production: its tables were never created (and had no row level security), and its API never mounted because the database module it needed didn't exist. Its forms posted to endpoints that would have refused anyone not signed in. It was removed; git history keeps it. The Concierge's parent approval of each coach message comes back on the new tables in its own change.
