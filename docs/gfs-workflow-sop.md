# Pylon events: the run sheet in the app

The shareable SOP for Pylon is the **Pylon Event Workflow SOP v1** doc (https://claude.ai/artifact/LEJRnbHZQXqrPunnKmAKs7). This file is how the app runs it: every stop has the same 12 stages, each with one deadline, one owner and one test for done.

Code: `utils/gfs.js` (`RUN_SHEET`, `runSheet`, `stageIsMine`, `uploadCheck`, `crewBrief`), `routes/gfs.js` (the event plan, `/today`, `/events/:id/brief`, the upload log, the review on `PATCH /events/:id`), `public/app/gfs.js` (the plan's run sheet, the "Needs you" cards, the brief screen, the upload check on the live console) and `db/migrations/029_gfs_stop_review.sql`.

## The stages

Deadlines before the event count back from midnight on its first day; after it, from the wrap on its last day, both in the stop's time zone.

| Stage | Due | Owner | Done when |
| --- | --- | --- | --- |
| Staff the stop | T-45 days | Director | Invited or confirmed on-site crew at the crew target, with a lead |
| Screening complete | T-21 days | Kyron | The crew is at target and nobody on it has a screening problem for this stop |
| Crew confirmed | T-14 days | Director | The plan's crew check: confirmed and screened on site at target, a lead, no youth creator alone |
| QR codes and storefront | T-7 days | Director, approver | Marked ready on the QR codes screen |
| Roster and consent | T-72 hours | Director | The Sports Thread roster is loaded |
| Crew brief sent | T-48 hours | Director | Marked sent on the brief screen |
| Capture | Wrap | Crew lead | Game files are logged and every game has two wide angles (measured, not nagged) |
| Footage uploaded | T+12 hours | Crew, director | The upload log is loaded |
| Tag review done | T+24 hours | Director | Tags approved and nothing unmatched |
| On sale and sent | T+48 hours | Approver, director | Clips approved, nothing waiting for the edit or approval, every approved clip out, every file marked |
| Pylon deliverables | Schedule C dates | Approver | Every Schedule C piece cleared (Deliver has its own queue) |
| Stop review | T+14 days | Kyron | Marked reviewed, with one line on any change to the SOP (migration 029) |

## Status and "Needs you"

- **Soon:** from a week before the deadline. After-event stages only open once the stop has wrapped.
- **Late:** past the deadline and not done.
- **Missed:** staffing, screening, the crew and the brief, undone when the stop starts. They show on the plan but aren't nagged, since they can't be done anymore. The roster and the storefront stay late, because tags and sales still need them.
- **Who sees what:** the owner sees every stage. An approver sees the storefront and getting clips out. A director sees their own stages and getting clips out, for stops they direct or that have no director yet. Viewers see none.
- **When:** `/today` looks at stops from 52 days before their start to 45 days after they end, and lists late stages (oldest first) before stages due this week.

## The crew brief

`GET /api/gfs/events/:id/brief` (directors and up) builds the brief from the stop's own data:

- when and where, the crew and the director;
- the teams by their roster names;
- pre-sold athletes to cover first, and athletes no clip may feature, by team and jersey only;
- the capture, naming and upload standards;
- where families and help requests go.

It never carries a name, a roster ID or a reason for a hold. The director copies it, or opens their own email with the crew's addresses in BCC, then marks it sent. The app emails nobody.

## The upload check

Every upload-log load returns a `check` covering the whole stop:

- games logged;
- games missing a wide angle (Sideline and End Zone, or any two wide angles, as the scorecard counts them);
- game files and clips uploaded more than 12 hours after their final whistle;
- games with no final whistle;
- files marked unusable.

The event plan carries the same check as `upload_check`, and the live console shows it.

## Deploy order

Merge and let Render deploy, then apply migration 029 with Kyron's OK. Before 029, the review stage shows without being tracked, and marking a stop reviewed answers "Apply migration 029".
