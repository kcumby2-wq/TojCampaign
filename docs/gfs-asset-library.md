# The asset library (Ground Floor Sports · Pylon events)

One record for every digital asset GFS makes from a Pylon stop, with what it may be used for and what's stopping it. It's in the TOJ app under Events, and on each stop's event plan ("Assets from this stop").

Code:

- `routes/gfs-assets.js`: the API at `/api/gfs/assets`.
- `utils/gfs-assets.js`: the rules.
- `public/app/gfs-assets.js`: the screens.
- `db/migrations/027_gfs_assets.sql`: the tables, with the same rules in Postgres.

## What it holds

| Kind | What it is | Athletes | Where it goes live |
| --- | --- | --- | --- |
| **Edit** | A recap, montage, feature, reel, photo set or interview | Any it features | GFS storage, Pylon's channels or SportsClippers |
| **Venue World** | A 3D World of the venue, dressed for the stop | None, ever | GFS storage |
| **3D/4D Moment** | A 3D view of one athlete's moment, or a 4D one that moves through the play, made only for their family | Exactly one | The family's GFS library |
| **World Pass** | A numbered collectible edition of a published venue World from the same stop | None | The GFS store |
| **Narrative NFT** | The record of one verified clip or photo of one athlete | Exactly one | The Narrative NFT ledger |
| **Brand asset** | A graphic, template, LUT, overlay, logo or sponsor asset | None | GFS storage, or a link |

- **Clips stay in the clips tool.** The library shows each stop's clip counts and links to them.
- **Files stay where they are.** A record keeps where it goes live and GFS's label for the file, such as `Dallas2027-WR-11-EndZone-042`, plus its SHA-256 if you have it. Once it's out, the approver adds its ID there (a ledger token, a store listing, a post), once.
  - An ID or label can't have spaces or slashes, so no folder name with a person's name in it gets in. There's no ID or label without its place.
  - Only a brand asset can be a link. It's `https`, and it goes to Canva, Figma, Adobe or groundfloorsports.com, never a file host where footage could be.
- **Titles and notes** carry no names, contact details or links. The app and the database both refuse an email address, a phone number, `http://`, `https://`, `www.`, or a domain followed by a path (`drive.google.com/…`, `fb.watch/…`, `bbc.co.uk/…`), on the same normalized copy of the text team chat checks. "St.Louis/KC" and "Team.tv/ intro" are fine.
- **Athletes are roster rows** from the stop's Sports Thread roster, shown by team and jersey number. The record keeps their team and jersey as they were when added, so a roster change shows.
- **A stop's assets take its region.** If the stop moves to another region, its assets move with it, to the new region's directors.

## How an asset moves

**Draft → In review → Approved → Live → Retired.**

| Step | Who | What happens |
| --- | --- | --- |
| Draft | A Regional Director, in their regions (approvers and the owner anywhere) | Add athletes, details and the file: where it goes live and GFS's label for it. Only a draft can be deleted. |
| Send to review | The same | It needs where it goes live and the file's label. From here the details, the file and the athletes lock. |
| Checks | An approver, or Kyron for the Consent to Mint | Recorded in review only. A director records the venue's permission in a draft or in review. |
| Approve | An approver or the owner | They confirm the kind's checklist, and everything below has to pass. |
| Live | An approver or the owner | The file goes out as it was reviewed, and everything is checked again. The approver adds its ID there, if the place gave it one, such as a token number. It can't change after. |
| Back to draft | A director from review, an approver from approved | The approval and every check an approver or Kyron recorded are cleared, so they're recorded again for what's reviewed next. |
| Retire | A Regional Director and up | Retired is final. Retiring a Moment or an NFT clears the file's label and its ID there, its title, its note and the athlete, so the record keeps nothing about them. |

- **Why the file locks.** What an approver approves is the file that goes out. To change it, send the asset back to draft, which clears the review's checks.
- **Why the checks clear.** A check belongs to one review. Athletes change only in a draft, so the Consent to Mint or a Tier 4 check recorded for one athlete can never carry over to another.
- **Who sees what.**
  - Viewers read the library. They see that an asset is held, never why, never its checks, and never a roster ID or a file's ID.
  - National brand assets (no stop, no region) are everyone's to see and an approver's to change.
  - Who recorded or approved something shows by name, as "the owner", or as "a former teammate" once they've left the team.

## What has to be true

**Every athlete, in every kind:**

- no takedown;
- not do-not-publish;
- capture consent;
- the same team and jersey as when they were added.

**Each kind adds its own:**

| Kind | Also needs | From |
| --- | --- | --- |
| Edit | Marketing consent for every athlete it features | Pylon Schedule F; the deliverables rule |
| Edit listed on SportsClippers | Also sale consent and public display for every athlete, and nobody who may be under 13. The record has no family-only setting, so a listed edit counts as a public listing. | SportsClippers Schedule A (the clips gate in 024) |
| Venue World | The venue's signed permission, recorded by a director. The approver confirms the QC checklist: no people, no legible names or faces on signage, no jerseys with names, no sponsor marks without a licence. | Spec §3, §4.3; Pylon I-2 |
| 3D/4D Moment | See the list after this table. | Spec rules 2, 3, 6, §7, §9 |
| World Pass | A fixed price; its venue World published, from the same stop, and not a school venue | Collectibles Terms §2, §3; Scout B-2 |
| Narrative NFT | The roster's NFT permission, and the signed Consent to Mint, which only Kyron records | NFT Terms §3 and Schedule A; Spec §9A |
| Anything with a sponsor's marks | The sponsor's licence, recorded by an approver. A brand asset in the sponsor format always carries the marks. | Spec §4.3 |

**A 3D/4D Moment also needs:**

- the roster's 3D permission;
- no chance the athlete is under 13. That means no verified age, or a 12-and-under division, counts as under 13. Verifiable parental consent isn't tracked yet.
- not an Illinois stop, until counsel clears BIPA;
- every other player blurred or masked, and the family's Tier 4 consent on the CFR record. An approver records both, in review.

## When something changes after it's live

- **Losing a permission.** If an athlete in a live asset loses a permission, or a takedown is logged for them, the asset shows **Needs retiring**. The library counts these at the top.
- **Retiring it.** Take the file down where it lives, then retire the record.
- **Takedowns.** A takedown's "off every other surface" step stays open while a live asset shows the athlete, at any stop. The database refuses the step too.
  - The takedown says how many assets are still live, and at which stops, including stops in regions the director can't open.
  - Marking the step done while one is live tells the directors of those regions.

## Setting it up

1. **Apply migration 027 in Supabase, with Kyron's OK, after 026.** It needs 024's stops and roster. It adds `gfs_assets` and `gfs_asset_athletes`, the checks, a trigger on `gfs_events` that moves a stop's assets with it, and a new version of the takedown clock.
   - The checks added after the first draft of 027 are named constraints, dropped and added again, so running it over an earlier 027 brings that database up to date.
   - The new takedown clock is the same as 024's, plus the live-asset rule.
   - Everything is service-role only: RLS is on, and the API roles can't call the functions.
   - Until it runs, the library says it isn't set up yet, and takedowns and event changes work as before.
2. **Merge, then let Vercel and Render deploy main.** Nothing to set on the server.

## Open questions

1. **Consent to Mint vs. the roster's NFT permission.** Is the Sports Thread NFT permission the signed Consent to Mint, or a separate consent? Today the library needs both.
2. **Under 13.** Moments are blocked for anyone who may be under 13, because verifiable parental consent isn't tracked. Should the roster carry it?
3. **Tier 4.** An approver records that the family's Tier 4 consent is on the CFR record. Should that come from CFR directly?
4. **4D.** The agreements don't define 4D yet. Here it's a Moment that moves through the play, under the same 3D permission. Does Pylon's 3D Scope cover it?
5. **Edits on Pylon's channels.** A listed edit now needs sale consent, public display and 13 or older. An edit on Pylon's channels still follows the deliverables rule: capture and marketing consent. Should a public post also need public display and 13 or older?
6. **Brand link sites.** Brand links go to Canva, Figma, Adobe or groundfloorsports.com. Are there others GFS or Pylon keep brand assets in?
