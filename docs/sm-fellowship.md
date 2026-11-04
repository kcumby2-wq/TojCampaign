# Fellowship applications

Every creator who applies to the Subject Medias creator fellowship on subjectmedias.com/fellowship lands in the TOJ app and alerts Kyron. He reviews them under **Fellowship** on Today, approves the ones who fit, and sends each the payment link for their plan.

Code:

- `routes/sm-fellowship.js`: the API at `/api/sm/fellowship`.
- `utils/sm-fellowship.js`: the rules, the alerts and the approval note.
- `public/app/fellowship.js`: the screens.
- `db/migrations/032_sm_fellowship.sql`: the table, with the rules checked again in Postgres.

## The flow

1. **The application.** The form on subjectmedias.com/fellowship posts to the site's own `/api/apply` function, which forwards it to `POST /api/sm/fellowship` here with the same shared secret the booking form uses and the visitor's address as Vercel saw it. It asks for:
   - the applicant's name, email, phone (optional) and Instagram handle (optional, for the credit line);
   - the city they're near and the state;
   - their age: 18 or older, or 16 or 17. Under 16 can't apply. At 16 or 17, a parent or guardian's name and email (not the applicant's own) are required, and only the seats open at 16 or 17 can be picked: shadow, shooter, photographer;
   - the seat they want, the plan they lean toward, one to three links to their work, their gear and a few lines about themselves;
   - a box confirming their age group and that the work is theirs.
2. **The alert.** Kyron (everyone on `ADMIN_EMAILS`) gets a push and an email. The push uses fixed words only: the seat, the age group and the state. The email adds the city and the plan. It names an adult applicant and how to reach them; a 16- or 17-year-old's name, contact and guardian stay in the app. Links and what anyone wrote stay in the app.
3. **Review.** Today → Fellowship. Open an application, look at the work, talk with them (mark it **Talking**), then **Approve** or **Decline**. A private note keeps what you thought. Open applications are new, talking or approved.
4. **The approval note.** Approving drafts an email to the applicant, or at 16 or 17 to their parent or guardian and the applicant. It carries the payment link for their plan, with the application's id (`client_reference_id`) and the payer's email filled in, and the next steps: start the plan, sign the creator agreement, get screened, work a first stop. Edit it, then send it from the app, or copy it or open it in your mail app when email isn't set up. Only the people on the application ever get it.
5. **Joined.** When they've paid and signed, mark them **Joined**.

If the database can't take an application, the email carries the whole application instead, so it isn't lost. If email isn't set up either, the site shows the applicant the email address to write to.

## Settings (Render, `toj-csv-app`)

| Variable | What it is |
|---|---|
| `SM_BOOKINGS_SECRET` | The secret the booking form already uses. Nothing new to set. |
| `FELLOWSHIP_PAY_TOOLS` | The Stripe payment link for Tools + Community, $29 a month (an `https://buy.stripe.com/…` address). Without it, the note says the link comes in the next email. |
| `FELLOWSHIP_PAY_MEETINGS` | The Stripe payment link for Community + 2 Meetings a Week, $79 a month. |
| `EMAIL_USER`, `EMAIL_PASS` | The Gmail account and app password that send alert emails and approval notes. Without them, alerts are push only and notes go out from your own mail app. |

Billing stays in Stripe test mode until counsel picks the company, so start with test-mode payment links.

## Setting it up

1. **Apply migration 032 in Supabase, with Kyron's OK.** It only adds: the `sm_fellowship_applications` table and one function that checks the links. Until it runs, Fellowship in the app says it isn't set up yet, and the form's applications reach Kyron by email only. Without email set up either, the form asks applicants to write to hello@subjectmedias.com.
2. **Merge, then let Render deploy main.** The site's `/fellowship` page and `/api/apply` function ship with subjectmedias-site.
3. **Optional:** add the two payment links, and `EMAIL_USER` / `EMAIL_PASS`.

## API

| Route | What it does |
|---|---|
| `POST /api/sm/fellowship` | The form, through the site (the shared secret). Answers `{ ok: true }` and nothing else, so it never says whose application is already here. |
| `GET /api/sm/fellowship` | Staff: open applications (`?all=1` for every one). No contact, links or what anyone wrote. |
| `GET /api/sm/fellowship/:id` | Staff: one application, its drafted approval note and whether each plan's link is set |
| `PATCH /api/sm/fellowship/:id` | Staff: `{ status }` and `{ staff_note }` |
| `POST /api/sm/fellowship/:id/note` | Staff: email the approval note (`{ subject, text }`, or the draft as it is). Approved or joined only. |
| `DELETE /api/sm/fellowship/:id` | Staff: remove the application and everything in it |

## Rules

- The form takes only the site's call (the shared secret, compared by hash). It allows 5 applications per visitor per 10 minutes and 60 an hour in all, and drops anything that fills the hidden field. Staff alert emails stop at 30 an hour and approval notes at 60; pushes still go and every application is saved.
- One open application per email address. A second one gets the same answer as the first and no second alert.
- Applications are owner and staff only (`requireStaff`).
- Migration 032 enforces the shape: confirmed; a guardian with their own email at 16 or 17, and none on an adult's application; the seats open at 16 or 17; one to three https links with a real host and no sign-in details; approved and joined carry when they were approved. Emails are plain addresses, so an Email button can't be made to copy anyone in. The API roles can't read the table.
- Removing an application deletes it for good, for an applicant or a parent or guardian who asks.

## Open questions

1. **How long applications are kept.** Today they're kept until removed. Should declined and withdrawn ones be removed after six months?
2. **Paid and joined automatically.** The payment links already carry the application's id. When the plans' billing is set up, a Stripe webhook could mark the application joined.
3. **Into the crew pool.** A joined creator could go into the Pylon crew pool (`gfs_creators`) in one tap, so they show up as suggested creators on bookings in their region once they're screened.
