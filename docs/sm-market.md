# The Subject Medias marketplace (phase 1)

For the events Subject Medias runs itself. Our crews shoot; families, teams
and hosts buy. Sellers are Subject Medias and its crews only.

Phase 1 is one event end to end: the roster, families' choices from a QR,
uploads, AI-suggested jersey numbers that staff confirm, a link per event and
a link per family, single clips ($12) and photos ($8), Stripe Checkout, and
downloads. Phase 2 adds pre-paid packages and team or event bundles; phase 3
the edited products, the browse store and revenue reporting.

## How it runs

1. **Staff set up the event** in the TOJ app (Today → Marketplace): name,
   dates, teams, the jersey numbers they know. It starts as a draft.
2. **Families choose** from the "Their choice" QR at check-in
   (subjectmedias.com/m/CODE/consent): family only, OK to sell, OK to show
   publicly, or keep out, and the athlete's age (12 or younger, 13 to 15,
   16 or 17, 18 or older). 12 or younger is family only or keep out. Every
   choice but a keep-out says who's answering: a parent or legal guardian,
   18 or older, or the athlete as an adult (18 or older and a legal adult
   where they live; an athlete under 18 can't answer for themselves). A
   keep-out needs neither that nor an age (with no age, it's taken as 12 or
   younger). A first
   choice counts once the guardian confirms it from their email; a keep-out
   counts the moment it's sent. After that, anything more careful (a lower
   level, a younger age) counts at once, and anything that loosens (a higher
   level, an older age) waits for the email while their earlier answer
   stands, so nobody can loosen a
   guardian's answer just by knowing their address. Confirming gives the
   family a fresh family link (the same answer again is how a family that
   lost theirs gets a new one). Staff can record a choice given in person;
   it counts at once and emails the family link. If it's less careful than
   what that same email already said (an older paper form after a newer QR
   keep-out, say), the app shows what's saved and records it only when an
   approver taps "Record it anyway". If their answer changes while it's
   typed in (a QR keep-out landing), nothing is written over: the app says
   so. A keep-out recorded in person keeps the youngest age already given.
   A number not on the roster
   yet is added by the form; 0 and 00 are two numbers.
3. **Crews upload** from the app. Files go from the device straight to
   storage on a signed link (up to 2 GB each: MP4, MOV, M4V, JPG, PNG).
4. **The worker** (inside the web server) makes a watermarked preview and a
   poster with ffmpeg, then asks the AI which roster numbers it can read in
   three frames. The AI sees team names and numbers only.
5. **Staff review**: switch on the numbers that are really in it (the AI's
   guesses start switched off). An approver then ticks "Everyone who stands
   out in it is tagged" and approves it for sale. Nothing with a kept-out
   athlete in it can be approved. A save of who's in an approved item sends
   it back to review unless an approver ticks the box again (a member's save
   always does); tagging someone kept out always sends it back. An approval
   re-reads who's in it after it's written, so a change landing at the same
   moment sends it back too.
6. **Families find and buy**: on the event's clips page by team and number
   (it needs the event's access code), or on their family link. Checkout is
   Stripe; the order page has the downloads (full quality, no watermark),
   and the link is emailed.

## The clips page's access code

Every event has an 8-letter access code (no look-alike letters, shown as
ABCD-EFGH). The clips QR and link carry it (`/m/CODE?k=KEY`); without it the
clips page asks for the code. Hand the clips QR out at check-in and share it
with teams. Never put it on a public poster: the consent QR is the poster
one, and it needs no code. Checkout needs the same code as the page.

Family pages and order pages never show the code: anyone can get a family
link (by answering the form for a number), so their link to the clips page
goes to the way in, which asks for it.

There's no limit on tries. A code is 8 characters from 32, about a trillion
codes, so it can't be guessed in practice, and the right code always opens
the page. A limit tied to an address could be filled by someone else (or by
families scanning an old QR after the code changed) and lock a venue's
families out. An approver can change the code in the app (the event →
Access code → New code). The old one stops working at once, so print the
new clips QR.

## Who sees what

Every athlete is a team and a jersey number at one event: never a name,
school or contact. The most careful answer among an athlete's guardians is
the one that counts, and staff keep-out beats everything. An item is shown
only where everyone confirmed in it allows it:

| Way in | Everyone in the item must be |
| --- | --- |
| The clips page (team and number, with the access code) | OK to sell, or OK to show publicly |
| A family's own link | their athlete: family only or more; everyone else: OK to sell or more |
| The browse store (phase 3) | OK to show publicly |

Nothing with no confirmed number is shown anywhere. 12 or younger is family
only: never on the clips page, never public. That holds if any guardian says
12 or younger, confirmed or not, and for an answer with no age.
A keep-out after a sale closes that file's download (the buyer is told to ask
for a refund). A full refund in Stripe closes the order's downloads.

## Where things are

- `db/migrations/033_sm_market.sql`: the tables and the private `sm-market`
  bucket. RLS on, service role only.
- `utils/sm-market.js`: the rules (levels, who may see what, inputs, emails).
- `routes/sm-market.js`: the staff API at `/api/sm/market` (the "market" team tool).
- `routes/sm-market-public.js` + `utils/sm-market-page.js`: the family pages at
  `/m/` (subjectmedias.com rewrites `/m/*` here) and the webhook's `paid()`.
- `utils/sm-market-worker.js`, `utils/sm-market-media.js`: the queue and ffmpeg.
- `assets/sm-market-watermark.png`: the preview mark.
- `public/app/market.js`: the app screens.

## Going live (Kyron)

1. Merge #34 (the fellowship) first: this branch is built on it.
2. Upgrade Supabase to Pro (organization "Subject report", Billing), then
   raise Storage's upload size limit to 2 GB (Project Settings → Storage).
   On the free plan a file over 50 MB won't upload.
3. Apply migration 033. It also creates the `sm-market` bucket.
4. Merge this PR, then the site's `/m/` rewrite (subjectmedias-site).
5. In Subject Medias' Stripe account (test mode), add the webhook below and
   put its keys on Render (the table below).
6. In the app, give the crew the Marketplace tool (Team → a person → Tools).

What the server needs, on Render:

| Setting | What it does | Needed? |
| --- | --- | --- |
| `EMAIL_USER`, `EMAIL_PASS` | Confirm emails, family links, order links | Yes: without them a QR choice can't be confirmed |
| `SM_STRIPE_SECRET_KEY` | Checkout, on Subject Medias' own Stripe account (a test key until it goes live) | Yes, to sell |
| `SM_STRIPE_WEBHOOK_SECRET` | The signing secret of that account's webhook | Yes, to sell |
| `SM_STRIPE_LIVE=yes` | Lets a live key take real payments | Only when going live |
| `ANTHROPIC_API_KEY` | Jersey-number suggestions | Without it, files reach review with no suggestions |
| `MARKET_TAG_MODEL` | The model that reads numbers | Optional (default `claude-haiku-5-5`) |
| `SM_MARKET_WORKER=off` | Turns the worker off on this server | Optional |
| `SM_SITE_BASE` | The address in links and QR codes | Optional (default `https://www.subjectmedias.com`) |
| `SM_HELP_EMAIL` | The address on the family pages | Optional (default `hello@subjectmedias.com`) |
| `FFMPEG_PATH` | A specific ffmpeg | Optional: `ffmpeg-static` installs one with `npm ci` |

Sales go to Subject Medias' own Stripe account, never the Creator Club's.
In that account (test mode first), add a webhook endpoint at
`https://tojcampaign.com/api/sm/stripe/webhook` with these events:
`checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.expired` (marks abandoned checkouts) and `charge.refunded`
(a full refund closes the order's downloads). Its signing secret is
`SM_STRIPE_WEBHOOK_SECRET`. Checkout takes cards only (with Apple Pay and
Google Pay), so paid means paid at once, and a checkout lasts 31 minutes.

## Decided (Nov 5, 2026)

- **Stripe:** Subject Medias' own account takes the event sales. Test mode
  until `SM_STRIPE_LIVE=yes`.
- **Consent wording:** Subject Medias has its counsel read the family pages,
  above all "OK to show publicly" (it names our store and our social pages,
  such as our Instagram, @subjectmedias),
  before the first live event.

## Decided (Nov 6, 2026): before the next event

- The clips page needs the event's access code.
- 12 or younger is family only. Answers carry an age band, and the
  guardian's attestation (18 or older, or the athlete as an adult) is
  required for every choice but a keep-out.
- Approving takes the approver's check that everyone who stands out is
  tagged, and nothing with a kept-out athlete in it is approved.
- Still open: a second check beyond email (a text code) before "OK to sell"
  or "OK to show publicly" counts. It needs an SMS provider.
- Still open: how a family proves it's the family. Today anyone who answers
  for a number with their own email gets that number's family link. Options:
  check answers against registration's guardian emails, or hold a second
  family's link for staff until the first is told.
- For counsel: whether selling one child's clip to another family is a
  "sale" under state privacy laws; whether a parent may answer for an
  athlete who's 18 or older (the form allows it, for states where 18 isn't
  yet a legal adult); and whether clips with two family-only athletes may be
  sold to either family.

## Limits to know

- Self-asserted guardianship and age: whoever controls an email address can
  answer for a number with it, and the age band is what they say. Once
  confirmed, that answer's family link shows the number's clips, family only
  ones included. Staff see every answer and any change waiting to be
  confirmed (approvers see the addresses) and can remove one; removals are
  logged. A keep-out from anyone counts at once, which only ever protects.
  Closing this needs a way to know who the family is (see "Still open").
- A clip with two or more family-only athletes in it isn't sold to anyone,
  and 12 or younger is always family only. At a 12U event, most clips with
  two tagged players can't be sold.
- Per-visitor limits count a visitor by their whole X-Forwarded-For chain,
  so a caller can't fill someone else's (Render adds the address that
  reached it). Families on one venue's Wi-Fi count as one visitor, so the
  limits leave room for a crowd: 2,000 page views, 200 answers, 300 confirms
  and 100 checkouts per 10 minutes. Changing the chain dodges them, which is
  why emails are capped per mailbox, per athlete and per event.
- Email goes through the Gmail account in `EMAIL_USER`. Gmail sends about
  500 a day (about 2,000 on Google Workspace), and the form sends at most
  200 an hour from one event. A big event's check-in can need more: a
  sending service (Postmark or Amazon SES, say) would lift both.
- The clips page's Stripe "back" link carries the access code, so it's kept
  in Subject Medias' Stripe account with the checkout.
- The QR form emails whatever address is typed in, so its emails are capped:
  3 an hour (8 a day) to one mailbox (a +tag or Gmail dots count as the
  same mailbox), 12 an hour about one athlete, 200 an hour from one event,
  and 200 answers per visitor per 10 minutes. A keep-out or a more careful
  answer is saved past every cap (just without its note); only a flood
  (3,000 answers an hour at one event) stops the form, and then the crew
  records choices in person. An answer is saved only if the guardian's
  answer is still as it was read, so two at once can't undo a keep-out.
- Previews cover a clip's first 90 seconds, at 480p, silent. Long files take
  longer; cut long game film into clips first.
- The worker runs one file at a time inside the web server, and downloads
  each original to the server's temp disk. A failed file is retried on the
  next pass, three tries in all, then waits for staff (Review → Failed). A
  file that can't work (not a video or photo, over an hour, over 20,000
  pixels) fails at once with the reason.
- A file someone has bought can't be removed. A checkout started in the last
  hour holds it for now; checkouts that ended unpaid don't count.
- Order links don't expire; downloads are signed for an hour each time the
  order page opens.
