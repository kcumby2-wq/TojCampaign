# The Pylon pages

The public Pylon pages on tojcampaign.com take real requests now. Each form saves a request, staff get a push and an email, and the person who sent it gets one note. When Pylon's Stripe is set up with a live key, the page goes straight on to a Stripe checkout at the server's price.

| Page | What it takes | Kind |
| --- | --- | --- |
| `/pylon-team-packages.html` | A coach books team coverage: Recap $299, Season Pack $1,499, Combine Book $2,999 | `team_package` |
| `/pylon-player-packages.html` | Coverage of one athlete at an event: Snapshot $69, Story $99, Feature $199 | `player_package` |
| `/pylon-athlete-subscribe.html` | The Athlete Transcript: Individual $99 or Combine $249 for the season | `transcript` |
| `/pylon-recruiting.html` | The Recruiting Concierge: Standard $99 a month or $499 a season, HBCU Premium $149 a month or $749 a season | `recruiting` |
| `/pylon-newsletter.html` | The free list (confirmed by email), and Premium at $9.99 a month | `newsletter_premium` |
| `/pylon-ambassadors.html` | An application for Standard, Featured or Flagship | `ambassador` |

The code: `routes/pylon.js` (the API), `utils/pylon.js` (prices, what each form must carry, the consent words, the emails), `utils/pylon-stripe.js` (Stripe), `utils/pylon-http.js` (limits and the origin check), `public/pylon-forms.js` and `public/pylon-forms.css` (the pages' forms), `public/app/pylon.js` (the app screens), migration `036_pylon_requests.sql`.

## Who can send what

* A form about one athlete (player coverage, transcript, Concierge, ambassador) starts with "Who's filling this in?": the athlete's parent, the athlete's legal guardian, or the athlete at 18 or older. An athlete under 18 is asked to have their parent or guardian fill it in, and the form won't send.
* "18 or older" has to fit the class year: from August, the class two years past this year's seniors can't be 18 yet (in November 2026, the class of 2029 or later). The form says a parent or guardian fills it in.
* The person ticks a box next to the exact words they're agreeing to. The page sends those words with the form, and the server refuses the form unless they're the words it would store (so the words on file are the words the person read, even while a new page and a new server roll out). They're kept on the request as they were (`consent_text`), with who answered (`consent`). The database refuses an athlete on a request without both. Changing the answer to "Who's filling this in?" unticks the box, since the words changed.
* No form clears public posting. Player coverage is for the family; the words say Pylon posts it publicly only with a separate yes from a parent or guardian (or the athlete at 18+), recorded at the event.
* The Concierge's words say nothing goes to a coach until the parent approves the exact message.
* An ambassador application from a parent or guardian needs the parent's own email, not the athlete's (Gmail's dots and +tags count as the same mailbox). Nothing starts until they sign an agreement.
* A team booking names no athlete. The coach's note says we only post an athlete's footage publicly once their parent or guardian has said yes.
* Names are names: letters (any alphabet), spaces, apostrophes, hyphens, commas and periods ("Jr.", "A.J."). Nothing that reads as a link or an address ("evil.example"), since names go into the emails.
* Anyone can fill in a form and type any address. So before anything is done for an athlete (filming a player package, delivering anything, setting up a Transcript profile, asking about coach messages), staff call or meet the contact, check they're the athlete's parent or legal guardian (or the athlete, 18 or older) and that the email is theirs, and tap **I checked: it's them**. The request records who checked and when (`contact_verified_at`, `contact_verified_by`); the list says "Not checked yet" until then, and an athlete's request can't be marked Confirmed or Done before it (the database refuses too).

## Who sees it

Requests are for the owner (ADMIN_EMAILS, staff role), like the Subject Medias bookings: they hold minors' names and money. In the TOJ app: the **Pylon** tile on Today, or Tools → Pylon.

* `#pylon`: open requests (`#pylon/all` for every one). Flags: Not checked yet, Test payment, "Paid twice: check it", and a monthly plan that's past due or cancelled.
* `#pylon-request/<id>`: who to call, checking who they are, the athlete, what they agreed to, payment, status (New, Contacted, Confirmed, Done, Closed) and a team note.
  * "Paid another way" records a payment made outside Stripe (an invoice, cash) and closes the family's open Stripe checkout, so they can't also pay there. Only that kind can be taken back. Refunds of Stripe payments happen in Stripe.
  * **Delete** (two taps) is for a request someone says they didn't send. Its Stripe checkout is closed first, so nobody can pay for a request that's gone. A paid request, one with a further Stripe payment on it, or one whose checkout Stripe shows as paid already stays on file. If Stripe can't be asked about a live checkout from the last day, it stays too (try again; with no Stripe key on the server, a day after it came in). A test-mode checkout never holds a delete up.
* `#pylon-newsletter`: the confirmed list, with a button that copies it as CSV: `email,unsubscribe_url`.

The staff push and email say what came in and link to the app. Names and contact details stay in the app. If the database can't take a request, the staff email carries all of it (it's then the only copy).

## Emails

| Who | When | Says |
| --- | --- | --- |
| The contact | The request comes in | We got it; what happens next; the payment line (checkout, or we'll send a link); what they agreed to; "Didn't send this? Reply and we'll delete it." |
| The contact | Stripe confirms a payment | Payment received; Stripe sends the receipt; how to cancel a monthly one. A test payment's note starts `[TEST]` and says no money moved. |
| A newsletter address | Someone subscribes it | A link to confirm. Nothing else is sent until they do. Works for 7 days. |
| Staff | Each request, each payment | What and where, and the app link. A test payment says TEST. |
| Staff | A further payment on a request | Stripe took money on a request that was already paid (or through a checkout that isn't the request's own): check it, refund one in Stripe. |
| Staff | A monthly plan stops | Its renewal failed (past due, unpaid) or it was cancelled. |
| Staff | A payment with no request | Stripe took money through a Pylon checkout whose request isn't in the app (deleted, or never saved): refund it, or add the request by hand. |

Replies go to `PYLON_HELP_EMAIL` (default hello@pylonfootball.com). The sender is the app's mail settings (EMAIL_FROM or the Gmail account), the same as every other email the app sends.

## Limits

So the forms can't be used to fill anyone's inbox or lock people out:

* Forms: 12 per visitor per 10 minutes (a visitor is the address Vercel passes on; on IPv6, the /64), counted before the form is checked, so one visitor's junk stops only them. That's the only limit ordinary traffic meets: what a form sets off (notes, staff emails, pushes) has its own caps, below.
* Two circuit breakers for floods, counted only for forms that pass: 600 per connection to the server per 10 minutes, and 1,000 an hour (separately for requests and newsletter sign-ups). Through Vercel every visitor shares Vercel's connection, so these are shared by everyone; a busy event (hundreds of families) stays well under them.
* The newsletter's confirm and unsubscribe links: 30 tries per visitor per 10 minutes. The 256-bit token is what stops a guess.
* Known limit: someone who can send believable forms from many addresses (each IPv6 /64 counts as one visitor; one /56 holds 256 of them), through Vercel or straight at Render, can trip the breakers and turn everyone away until the count resets (10 minutes to an hour). Staff get a push and an email the first time in an hour. The lever then is Vercel's firewall: Attack Challenge Mode, or a rate-limit rule on `/api/pylon`. Vercel marking its own traffic (Edge Middleware adding a secret header) would stop forged addresses straight at Render, not a flood through Vercel.
* Notes from forms: at most 2 a day to one mailbox (1 a day for a newsletter confirmation), 6 a day from one visitor, 30 an hour and 100 a day in all. A note that couldn't go gives its place back, and the app shows which requests got one.
* Payment notes have their own count (5 a day to one mailbox, 30 an hour, 100 a day), so junk forms can't hold up a receipt.
* Staff emails: 30 an hour and 100 a day (the push always goes, up to 60 an hour). Money alerts (payments, second payments, plans that stop, payments with no request) have their own 30 an hour and 100 a day, and their own pushes, so busy forms can't hold them up. When the database is down, the "only copy" emails: 10 an hour and 30 a day. Past that, the page says it couldn't take the request.

## Payments

The public posts (`/requests` and the newsletter's) take JSON only, from the site's own pages: another site's form can't send JSON, and a browser's post from another site carries that site's Origin, which is refused.

Until a live key is in, the pages say "Send request" and people hear we'll send a secure payment link. Staff send one (or mark it paid another way).

With a live key in, the button says "Continue to payment" and each request goes on to a Stripe checkout made by the server: the price from `utils/pylon.js`, the request's id on it, cards only. A monthly package (Concierge monthly, Newsletter Premium) is a Stripe subscription; everything else is one payment. Back from Stripe, the page says Stripe sends the receipt and we'll be in touch. The payment joins its request only when Stripe's signed webhook says so.

**Test mode is staff only.** With a test key, the public pages still say "Send request"; staff signed in to the app on tojcampaign.com see "Continue to payment" and a test checkout. So nobody outside can "pay" with a test card.

Creator codes: a player-package link with `?ref=CODE` shows the code and sends it with the request. The checkout applies it only when Stripe has an active promotion code by that name whose metadata has `pylon_creator` = `yes`. Nobody can type a code at checkout, so other promotion codes on the same Stripe account never come off a Pylon checkout. A code that takes the whole price off completes as paid, $0.

Second payments are never dropped: money Stripe takes on a request that's already paid, or through a checkout that isn't the request's own, is kept on the request (`extra_payments`) and staff are told. While it's there, the hand-marked payment can't be taken back and the request can't be deleted; refund the one that shouldn't stand in Stripe.

The webhook listens for `checkout.session.completed` (and `checkout.session.async_payment_succeeded`), `customer.subscription.updated` and `customer.subscription.deleted`. A monthly plan's status (active, past due, cancelled) shows on its request. Stripe can deliver events late or out of order (a retry of one that failed), so an event older than the last one applied changes nothing, and a plan that ended stays ended.

## Go-live settings (Render, toj-csv-app)

Pick the Stripe account that takes Pylon's payments (per the Pylon agreement). Then:

1. `PYLON_STRIPE_SECRET_KEY`: a restricted key on that account with **Checkout Sessions: Write** and **Promotion Codes: Read**. If a checkout is refused for a missing permission, the server log says which; add it to the key. Start with a test key (`rk_test_…`).
2. In that Stripe account: Developers → Webhooks → add endpoint `https://tojcampaign.com/api/pylon/stripe/webhook` with the events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.updated` and `customer.subscription.deleted`. Put its signing secret in `PYLON_STRIPE_WEBHOOK_SECRET`.
3. For creator codes: a 25%-off coupon, and a promotion code per creator under it, each with metadata `pylon_creator` = `yes`.
4. Test: sign in to the app on tojcampaign.com, open a Pylon page, send a player request, pay with Stripe's test card, and check the request shows "Test payment" in the app and the `[TEST]` receipt note arrives. Signed out, the same page should say "Send request".
5. Live: swap in the live restricted key, add the live webhook endpoint and its secret, and set `PYLON_STRIPE_LIVE=yes`. A live key does nothing without it.

Optional: `PYLON_HELP_EMAIL` (where replies go), `PYLON_APPROVAL_REPLY_TO` (an address nobody reads, for replies to the Concierge's approval emails; unset, they go back to the family), `PYLON_SITE_BASE` (where the pages live, default https://tojcampaign.com; Stripe sends people back there, and posts from it are accepted).

## The newsletter list

`pylon_newsletter` holds each address once: pending, confirmed or unsubscribed. Only confirmed addresses are on the list. Every issue sent to the list must carry that address's unsubscribe link (the app's CSV has it):

`https://tojcampaign.com/pylon-newsletter.html?unsubscribe=<unsubscribe_token>`

The page asks them to tap Unsubscribe (so an email scanner opening the link changes nothing), then takes the address off.

## The Concierge's messages to coaches

Nothing goes to a college coach unless the person who signed up for the Concierge approved that exact message, to that exact coach and program. That's the athlete's parent or legal guardian, or the athlete at 18 or older: the request's contact, whom staff have checked on a call or in person (**I checked: it's them** on the request).

In the app, a Concierge request has **Messages to coaches**:

1. **New message**: the coach, their email, the program, the level, the subject and the message.
2. **Ask the family to approve** emails the request's contact a one-time link. It's offered only once the contact is checked, and only while the request is open (not Done or Closed). Staff never see the link. It works once, for 14 days. Asking again replaces it. Changing anything the family is shown (the coach, their email, the program, the level, the subject or the message) while a link is out cancels the link. **Cancel the link** stops one that went to the wrong place.
3. The family reads the message exactly as it would go out, types their name, ticks that they're the parent or guardian (or the athlete, 18+), and approves or declines. Staff get a push and an email saying which message was decided. The family gets a receipt by email, so if anyone else used their link, they find out at once.
4. Once approved, the message can't change. Give it an hour (the family's receipt), then send it from your own email: **Open in email** fills it in (a very long message is copied instead: the address, the subject and the message each have their own Copy), then **Mark sent**.
5. If the family says to stop an approved message, **The family took it back** (two taps): it can never be marked sent. Write a new one if they want another.
6. When a coach writes back, **A coach replied** adds a line to the message's history. Real interest (a camp invite, an offer): call the family too.
7. **Weekly update for the family** writes the week's update from the history: what went out, what came back, what's waiting on them. Read it over, then send it from your email.

Every card change carries what the card showed: if the family answered (or someone else asked) meanwhile, the click is refused and the card shows what's there now.

The link is safe from the places links usually leak:
- it carries the token after `#t=`, which browsers never send to a server, so no request log holds it; the page keeps it for that tab only (a phone that reloads the page still works) and says "try again in a minute" when the server is busy or down, rather than calling a live link dead;
- replies to the approval email don't come to staff (a reply quotes the link): they go to `PYLON_APPROVAL_REPLY_TO` if it's set (an address nobody reads), or back to the family's own address, and the email says to write to the help address in a new email;
- with Gmail as the app's mail account, the Sent folder keeps a copy of every approval email, links included: whoever can open that account can see live links. A sending service (the SMTP settings) keeps no such copy. Approval emails have their own share of the day's email budget, so busy public forms can't hold them up.

The database holds the same line (migration `037_pylon_outreach.sql`):
- the link's token is turned into a proof (its hash) by the server, and the table keeps only the proof's hash: nothing that can read the table can decide, and the trigger checks the proof against the link it burns;
- an approval carries the fingerprint of everything the family was shown when the link went out, and nothing they were shown can change in the same update;
- links go out only on an open request whose contact is checked, and stop working if that changes;
- nothing changes after approval; a decline stays as recorded until the family is asked again;
- nothing is marked sent without approval, after the family took it back, or twice;
- every link, decision, cancellation, withdrawal and send is written to `pylon_outreach_events`, which is never changed; a message with any of that on record is never deleted.

The family's page uses two database functions that only the server can call. The code: `routes/pylon-outreach.js` (staff), `routes/pylon-parent.js` (the family's link), `public/parent-approval.html`.

## What this replaced

The old design (migrations 008, 013 and 016, `routes/pylon.js` with about 60 endpoints, the old `routes/pylon-parent.js` and `public/parent-approval.html`, the sequence cron, six admin pages, `utils/parentApproval.js` and a seed of sales sequences) never ran in production: its tables were never created (and had no row level security), and its API never mounted because the database module it needed didn't exist. Its forms posted to endpoints that would have refused anyone not signed in. It was removed; git history keeps it. The Concierge's approval of each coach message is rebuilt on the new tables (above).
