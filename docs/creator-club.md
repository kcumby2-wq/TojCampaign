# Creator Club — phase 1 (the Creators tool)

The plan, with the ladder, the two money lanes, ownership, mentorship and the phases, is the doc "Creator Club — plan". This file covers running the tool.

## Where it is

TOJ app → **Tools → Creators**. The owner has it. Teammates get it when Kyron ticks **Creators** on their invite.

| Role | Can |
|---|---|
| Viewer | See creators, events and QR codes |
| Member | Add creators, edit drafts, add events and crew, see orders and buyers, export CSVs, ask for a page to go live |
| Owner | Approve a page, take it down, set the creator's share and rung, club status, camera approval, start payouts setup |

## The flow

1. **New creator.** Fill in the form, or paste a Jotform export. It's saved as a draft with its checks: banned TOJ words, colors that can't be read, prices, and a guardian for under-18 creators.
2. **Edit page.** Fix anything marked **Fix**.
3. **Ask to go live.** The request is refused while anything is marked **Fix**. Kyron gets a notification.
4. **Kyron previews and approves.** The page is live at `tojcampaign.com/c/<slug>`.
   - Once a page is live, only Kyron can change what the public sees.
   - The page address can't change once a page has been requested, because QR codes point at it.
5. **Set up payouts** (owner).
   - Makes a Stripe Express account and an onboarding link for the creator to finish. For under-18 creators, the account goes to the parent or guardian.
   - When they're done, tap **Check status**.
6. **Events.** Each event gets a 6-character code, a QR code, and a printable card. Each crew member gets their own card, which credits their sales.
7. **Sales.**
   - Orders arrive through the Stripe webhook.
   - Members move each order through Paid → Shooting → Editing → Delivered.
   - The CSV for each event uses the columns you tick. It holds buyer contact details.

## Stripe (test mode until counsel picks the company)

Set these on Render:

| Setting | Value |
|---|---|
| `CREATOR_STRIPE_SECRET_KEY` | the platform account's **test** secret key (`sk_test_…`) |
| `CREATOR_STRIPE_WEBHOOK_SECRET` | the signing secret of the webhook below |
| `CREATOR_PAGE_BASE` | optional; defaults to `https://tojcampaign.com` |

- **Webhook:** in the Stripe dashboard (test mode), add the endpoint `https://tojcampaign.com/api/creators/stripe/webhook` with the event `checkout.session.completed`.
- **Connect** must be turned on for the platform account, with Express accounts.
- **Live keys are refused.** A `sk_live_…` key does nothing unless `CREATOR_STRIPE_LIVE=yes` is also set. Set that only after counsel signs off on the company and the terms.
- **The split:** the buyer pays the platform. The creator's share (80% by default; owner-only, 50–95%) goes to their connected account as a destination charge. The platform's share is the application fee, and Stripe's own fees come out of it.

## Data

- **Migration 021** (applied Oct 21, 2026) adds five tables: `creators`, `creator_events`, `creator_crew`, `creator_orders` and `creator_webhook_events`. All are service-role only.
- **Orders** hold the buyer's name, email and phone, plus the athlete's team and jersey and Instagram, as typed at checkout.
- **Where buyer details never appear:**
  - on the page
  - in notifications
  - in logs, which carry ids and slugs only
- **Consent:**
  - The buyer must confirm they're the parent or guardian, or that the athlete is 18 or older.
  - Posting the athlete publicly is a separate, optional box, saved as `consent_public`.

## Tests

- `tests/creators.test.js`: access, intake and checks, page approval, live-page rules, guardian, Stripe Connect with a stand-in, checkout split, webhook idempotency, CSV, and refusing live keys.
