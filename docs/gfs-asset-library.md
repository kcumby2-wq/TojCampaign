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
| **World Pass** | A numbered collectible edition of a published venue World | None | The GFS store |
| **Narrative NFT** | The record of one verified clip or photo of one athlete | Exactly one | The Narrative NFT ledger |
| **Brand asset** | A graphic, template, LUT, overlay, logo or sponsor asset | None | GFS storage, or a link |

- **Clips stay in the clips tool.** The library shows each stop's clip counts and links to them.
- **Files stay where they are.** A record keeps the place and the file's ID or label there, such as `Dallas2027-WR-11-EndZone-042`, plus its SHA-256 if you have it.
  - An ID or label can't have spaces or slashes, so no folder name with a person's name in it gets in.
  - Only a brand asset can be a link, and only `https`.
- **Athletes are roster rows** from the stop's Sports Thread roster, shown by team and jersey number. The record keeps their team and jersey as they were when added, so a roster change shows.

## How an asset moves

**Draft → In review → Approved → Live → Retired.**

| Step | Who | What happens |
| --- | --- | --- |
| Draft | A Regional Director, in their regions (approvers and the owner anywhere) | Add athletes, details and where it lives. Only a draft can be deleted. |
| Send to review | The same | The details lock. |
| Approve | An approver or the owner | They confirm the kind's checklist, and everything below has to pass. |
| Live | An approver or the owner | It has to be in the place the kind goes live, with its ID. Everything is checked again. |
| Retire | A Regional Director and up | Retired is final. Retiring a Moment or an NFT clears where the file was and the athlete, so the record keeps nothing about them. |

- **Who sees what.**
  - Viewers read the library. They see that an asset is held, never why, and never a roster ID or a file's ID.
  - National brand assets (no stop, no region) are everyone's to see and an approver's to change.

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
| Venue World | The venue's signed permission, recorded by a director. The approver confirms the QC checklist: no people, no legible names or faces on signage, no jerseys with names, no sponsor marks without a licence. | Spec §3, §4.3; Pylon I-2 |
| 3D/4D Moment | See the list after this table. | Spec rules 2, 3, 6, §7, §9 |
| World Pass | A fixed price; its venue World published, and not a school venue | Collectibles Terms §2, §3; Scout B-2 |
| Narrative NFT | The roster's NFT permission, and the signed Consent to Mint, which only Kyron records | NFT Terms §3 and Schedule A; Spec §9A |
| Anything with a sponsor's marks | The sponsor's licence, recorded by an approver | Spec §4.3 |

**A 3D/4D Moment also needs:**

- the roster's 3D permission;
- no chance the athlete is under 13. That means no verified age, or a 12-and-under division, counts as under 13. Verifiable parental consent isn't tracked yet.
- not an Illinois stop, until counsel clears BIPA;
- every other player blurred or masked, and the family's Tier 4 consent on the CFR record. An approver records both.

## When something changes after it's live

- **Losing a permission.** If an athlete in a live asset loses a permission, or a takedown is logged for them, the asset shows **Needs retiring**. The library counts these at the top.
- **Retiring it.** Take the file down where it lives, then retire the record.
- **Takedowns.** A takedown's "off every other surface" step stays open while a live asset shows the athlete, at any stop. The Distribution desk says how many are left, and the database refuses the step too.

## Setting it up

1. **Apply migration 027 in Supabase, with Kyron's OK, after 026.** It adds `gfs_assets` and `gfs_asset_athletes`, the checks, and a new version of the takedown clock.
   - The new takedown clock is the same as 024's, plus the live-asset rule.
   - Everything is service-role only: RLS is on, and the API roles can't call the functions.
   - Until it runs, the library says it isn't set up yet, and takedowns work as before.
2. **Merge, then let Vercel and Render deploy main.** Nothing to set on the server.

## Open questions

1. **Consent to Mint vs. the roster's NFT permission.** Is the Sports Thread NFT permission the signed Consent to Mint, or a separate consent? Today the library needs both.
2. **Under 13.** Moments are blocked for anyone who may be under 13, because verifiable parental consent isn't tracked. Should the roster carry it?
3. **Tier 4.** An approver records that the family's Tier 4 consent is on the CFR record. Should that come from CFR directly?
4. **4D.** The agreements don't define 4D yet. Here it's a Moment that moves through the play, under the same 3D permission. Does Pylon's 3D Scope cover it?
5. **Edits of athletes who may be under 13.** Edits follow the deliverables rule: capture and marketing consent. Should anything public also need public display and 13 or older, as SportsClippers listings do?
