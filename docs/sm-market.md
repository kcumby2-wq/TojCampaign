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
   publicly, or keep out, and whether the athlete is 12 or younger. A first
   choice counts once the guardian confirms it from their email; a keep-out
   counts the moment it's sent. After that, anything more careful (a lower
   level, "12 or younger") counts at once, and anything that loosens waits
   for the email while their earlier answer stands, so nobody can loosen a
   guardian's answer just by knowing their address. Confirming gives the
   family a fresh family link (the same answer again is how a family that
   lost theirs gets a new one). Staff can record a choice given in person;
   it counts at once and emails the family link. A number not on the roster
   yet is added by the form; 0 and 00 are two numbers.
3. **Crews upload** from the app. Files go from the device straight to
   storage on a signed link (up to 2 GB each: MP4, MOV, M4V, JPG, PNG).
4. **The worker** (inside the web server) makes a watermarked preview and a
   poster with ffmpeg, then asks the AI which roster numbers it can read in
   three frames. The AI sees team names and numbers only.
5. **Staff review**: switch on the numbers that are really in it (the AI's
   guesses start switched off), then an approver approves it for sale.
6. **Families find and buy**: on the event page by team and number, or on
   their family link. Checkout is Stripe; the order page has the downloads
   (full quality, no watermark), and the link is emailed.

## Who sees what

Every athlete is a team and a jersey number at one event: never a name,
school or contact. The most careful answer among an athlete's guardians is
the one that counts, and staff keep-out beats everything. An item is shown
only where everyone confirmed in it allows it:

| Way in | Everyone in the item must be |
| --- | --- |
| The event page (team and number) | OK to sell, or OK to show publicly |
| A family's own link | their athlete: family only or more; everyone else: OK to sell or more |
| The browse store (phase 3) | OK to show publicly |

Nothing with no confirmed number is shown anywhere. Under 13 is never public.
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
5. In the app, give the crew the Marketplace tool (Team → a person → Tools).

What the server needs, on Render:

| Setting | What it does | Needed? |
| --- | --- | --- |
| `EMAIL_USER`, `EMAIL_PASS` | Confirm emails, family links, order links | Yes: without them a QR choice can't be confirmed |
| `CREATOR_STRIPE_SECRET_KEY`, `CREATOR_STRIPE_WEBHOOK_SECRET` | Checkout, on the Creator Club platform account (test mode) | Yes, to sell |
| `ANTHROPIC_API_KEY` | Jersey-number suggestions | Without it, files reach review with no suggestions |
| `MARKET_TAG_MODEL` | The model that reads numbers | Optional (default `claude-haiku-5-5`) |
| `SM_MARKET_WORKER=off` | Turns the worker off on this server | Optional |
| `SM_SITE_BASE` | The address in links and QR codes | Optional (default `https://www.subjectmedias.com`) |
| `SM_HELP_EMAIL` | The address on the family pages | Optional (default `hello@subjectmedias.com`) |
| `FFMPEG_PATH` | A specific ffmpeg | Optional: `ffmpeg-static` installs one with `npm ci` |

The Stripe webhook already sends `checkout.session.completed` to
`/api/creators/stripe/webhook`. Add `checkout.session.expired` (marks
abandoned checkouts) and `charge.refunded` (a full refund closes the order's
downloads) to the same endpoint. Checkout takes cards only (with Apple Pay
and Google Pay), so paid means paid at once, and a checkout lasts 31 minutes.

## Decisions still open

- Which Stripe account takes Subject Medias' event sales. Today it's the
  Creator Club platform account, in test mode until counsel picks the company.
- The consent wording, above all "OK to show publicly" (it names our store
  and our social pages). Worth a read by counsel before the first live event.

## Limits to know

- Self-asserted guardianship: whoever controls an email address can answer
  for a number with it. Staff see every answer and any change waiting to be
  confirmed (approvers see the addresses) and can remove one; removals are
  logged. A keep-out from anyone counts at once, which only ever protects.
- The QR form emails whatever address is typed in, so its emails are capped:
  3 an hour (8 a day) to one address, 12 answers an hour for one athlete,
  200 an hour in all, and 40 tries per visitor per 10 minutes.
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
