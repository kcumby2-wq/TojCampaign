# Campaign intake

`/intake.html` (short link: `tojcampaign.com/intake`) is the form clients fill in
before TOJ quotes or builds a custom campaign. It asks the 31 questions from the
"TOJ Agency Brief and Campaign Intake" doc, word for word and in the same order,
across nine steps: Goal, Audience, Brand, Proof, Assets, Funnel, Channels and
scope, Approvals, then contact details and a review.

It replaces the old `/intake.html` redirect to the Foundation Score. The
Foundation Score itself is unchanged at `/foundation-score.html` (and
`score.tojcampaign.com`).

## How it fits together

| Piece | File | What it does |
|---|---|---|
| Questions | `public/js/campaign-intake-questions.js` | The one source of the questions, hints, field keys and the "Copy for TOJ" format. Loaded by the page, the CRM and the tests. |
| Page | `public/intake.html` | Renders the steps from the question list, autosaves on the device, checks the required answers, shows a review, and sends. |
| Send | `public/js/onboarding-submit.js` | Posts to `POST /api/onboarding` as `audience: business`, `branch: trail-of-joy`, `intake_version: campaign-v1`, `source: /intake.html`. |
| Store | `routes/onboarding.js` | Saves the row to `onboarding_intakes` (Supabase; `db/onboarding_intakes.json` in dev). Status starts at `new`. |
| Review | `public/admin/intake-crm.html` | Staff only. Campaign rows show a Campaign chip and an **Answers** button: the 31 answers by topic, and **Copy for TOJ**, which copies them as numbered Markdown to paste after the TOJ prompt. |
| Agents | `routes/onboarding.js`, `utils/embed.js` | Adult intakes are embedded to the agent RAG as before, minus every `contact_*` key. |

Required to send: questions 1, 2, 4, 5, 6, 9 (brand name), 15 (releases), 21,
27, 28 (production budget) and 29, plus name, email, preferred contact and the
privacy box. A phone number is required only when the client asks for a text
or a call. Everything else can stay blank; a blank becomes a question on the
first call.

## What it stores, and what it doesn't

- **On the device:** answers autosave to `localStorage` (`toj-campaign-intake-v1`)
  until the intake is sent, as the privacy policy describes. A successful send
  clears them; "Start over" clears them too. A failed send keeps them.
- **In the row:** email and phone go in the row's own columns. The payload holds
  the answers (`q01` … `q31_*`), `contact_name`, `contact_role`,
  `contact_method` and `privacy_agreed_at`.
- **Minors:** no question asks for a minor's name. Question 15 asks for roles
  and whether releases are on file; question 13 asks clients to leave out the
  names of anyone under 18. Campaign intakes are adult business intakes
  (`is_minor: false`).
- **Copy for TOJ** includes the answers only, never contact details.
- **The doc's "Why we ask" column is internal.** It names clients and past
  projects, so it never appears on the page. The form shows its own short hints,
  and a test keeps other brands and banned words off it.

## Changing a question

1. Edit `public/js/campaign-intake-questions.js`, and make the same change in the
   doc so the two stay word for word.
2. Keep field keys stable once intakes exist; the CRM and Copy for TOJ read
   them. If a question changes meaning, bump `VERSION` (for example
   `campaign-v2`) so older rows stay readable.
3. Run `npm test`. `tests/campaign-intake.test.js` checks the numbering, topics,
   keys, required contact fields, banned words and brand walls.

## Routes

- `/intake` → `/intake.html` (302, in `vercel.json` and `server.js`).
- The old `/intake.html` → `/foundation-score.html` redirect was permanent, so a
  browser that followed it before may still remember it. Share
  `tojcampaign.com/intake` in new links.

## Trying it

- Locally: `npm start` with no Supabase env (JSON fallback), open
  `http://localhost:3000/intake`, send, and look in `db/onboarding_intakes.json`.
- On a Vercel preview, `/api/*` is proxied to the production backend, so a test
  send lands in the live Intake CRM. Mark test rows `declined`.
