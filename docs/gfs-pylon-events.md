# Pylon events in the TOJ app (Ground Floor Sports)

The TOJ app runs Pylon events for Ground Floor Sports (Trail of Joy Management Group, LLC d/b/a Ground Floor Sports). Regional Directors use it to:

- plan their region's events;
- crew them with screened creators;
- load the Sports Thread roster and its consent flags;
- log footage and tag clips by jersey number;
- deliver what the Pylon agreement owes;
- send clips to families and SportsClippers;
- handle takedowns.

Kyron and Pylon's approvers see every region from the Distribution desk.

Code: `routes/gfs.js` (the API at `/api/gfs`), `utils/gfs.js` (the rules), `public/app/gfs.js` (the screens) and `db/migrations/024_gfs_events.sql` (the tables, plus the rules again as triggers, so a bug in the app can't break them). The QR codes and the public stop page they open are in `routes/gfs-page.js` (the page at `/e/<event code>`), `utils/gfs-page.js` and `db/migrations/025_gfs_qr.sql`.

## Who sees what

| Team role | In Pylon events | Sees | Can |
| --- | --- | --- | --- |
| Owner | Admin | Every region | Everything. Only the owner records creator screening, changes a screened creator's name or email, puts a paused creator back to work, and manages the team. |
| Approver | Approver | Every region | Clear what posts on Pylon's channels, approve clips, make the SportsClippers file, mark listings and make them family-only. Plus everything a director can do. |
| Member | Regional Director | Their regions | Plan events, crew them, load rosters and upload logs, tag clips, log deliverables, send work to approval, make the family-links file, log and work takedowns, add creators, pause a creator. |
| Viewer | Viewer | Their regions | Read only. Sees that a clip is held, never why. Never sees an athlete's permission flags, roster ID or the reason for a takedown. |

Regions: West, South Central, Northeast, Southeast and Midwest (the pylon-os territories).

The team activity feed follows the same lines. Pylon events entries go only to people with the tool, and a director or viewer sees only their regions' entries.

## Setting it up

1. **Deploy.** Merge to main.
   - Vercel serves the screens and passes `/api` through to the API, which runs on Render (`toj-csv-app`, in `render.yaml`).
   - Render has to deploy main too. Until it does, nobody sees Pylon events: the screens show the Events tab only when the API says a person has the tool.
2. **Apply migration 024 in Supabase**, with Kyron's OK. It adds `regions` to `team_members` and `team_invites` and creates the `gfs_*` tables.
   - Until it runs, the API answers `503 gfs_not_set_up`.
   - Everything else keeps working: sign-in reads the old columns if `regions` isn't there yet.
   - **Then apply migration 025**, also with Kyron's OK. It adds the stop page's links (the stop's SportsClippers page, an on-site help number, extra placements), each creator's SportsClippers page, and the scan and click counts. Until it runs, the QR screen answers `503 gfs_qr_not_set_up` when links are saved, and the stop page shows "This page isn't here".
   - **Set `GFS_PAGE_BASE`** on Render to the address the codes use. Kyron chose `https://media.groundfloorsports.com` (October 24).
     - Set it only once `media.groundfloorsports.com` points at the Vercel project that serves the app (`toj-campaign-noxn`) and Vercel shows it as verified.
     - Until it's set, the QR codes screen shows the links and counts but makes no codes. A printed code can't be recalled, and TOJ's own domain must never print on Pylon's signs, so `tojcampaign.com`, Render and `vercel.app` addresses aren't accepted.
     - The stop page itself answers on any address the app serves.
   - **`GFS_HELP_EMAIL`** sets the help and takedown address on the page. It defaults to `support@groundfloorsports.com`.
     - That inbox isn't set up yet (October 24).
     - Every help and takedown request from the page goes there, so it has to receive mail, and someone has to watch it on event weekends, before the first codes go out.
3. **Invite people.** In the app, go to Team → Invite and tick **Pylon events**.
   - **Regional Director:** pick Regional Director and at least one region.
   - **Approver** (Pylon's CEO, the Creative Lead): pick Approver. Approvers need no region.
   - The owner can change a director's regions later from Team → Change regions.
4. **Load the calendar.** An approver can go to Events → Load Pylon's calendar and choose `docs/gfs-calendar-2026-27.csv`.
   - It holds the 17 dated 2027 Legacy Tour stops from Schedule A-1 of the agreement and the three dated Girls Flag stops from A-4.
   - The National Championship has no location yet, so it isn't in the file.
   - Girls Flag is marked "[in scope / not in scope]" in A-4, and the file loads those stops as one-day tournaments.
   - Stops already in the app are skipped, so the file can be loaded again safely.
5. **Add creators** from Creators → Add. Kyron then records each creator's contract, background check and minor-safety training on their page.
   - Until all three are on file, and each is less than a year old at the event, the creator can't be crewed.
   - Once any of them is on file, the record belongs to that person. Only Kyron changes its name or email.

## An event, start to finish

1. **New event.** Pick a size:
   - **Premier Event, One-Day Tournament or Clinic.** The size sets the Schedule C counts and the crew target (3, 2 or 1 on site).
   - **Dates, wrap time and time zone.** Every deadline runs from the wrap time on the last day, in the event's own time zone.
2. **Plan.** Four checks before the event:
   - QR code and storefront page (T-7): the stop's codes printed and its page's links set, on the QR codes screen;
   - roster and consent from Sports Thread (T-72h);
   - crew brief sent (T-48h);
   - crew confirmed, with a lead.
3. **Crew.** Assign from the region's pool. The rules:
   - A youth creator (16–17) shoots or shadows, never leads or edits.
   - A youth creator is confirmed only alongside a confirmed, screened adult on site (lead, shooter, photographer or story camera).
   - That adult can't be removed, un-confirmed, moved off site or deleted from the crew while it would leave a youth creator alone. Two people changing the crew at the same moment can't get around this.
   - A creator whose screening lapses after they're crewed (a check over a year old at the event, or a pause) stops counting toward the crew. The crew check says so until Kyron updates it.
   - A creator's tier can't change while they're on an upcoming crew.
   - A family rating can go in after the event even if the creator has been paused since.
4. **Roster.** Load the Sports Thread CSV (format below).
5. **Live.** Load the upload log (the storage export). Game files feed the creator scorecards. Clips are tagged against the roster (format below).
6. **Tag review.** Fix what didn't match, or mark it *not a player*. Then **approve the game's tags**: matched clips that aren't held move to the edit.
   - A clip a director tags, untags or marks *not a player* stays that way. Re-matching never overrides a person's call.
7. **Deliver.** This covers two things:
   - **Schedule C deliverables.** Log counts and send what posts on Pylon's channels to approval. An approver clears it or sends it back with a note.
   - **Clips.** Mark them edited. An approver approves them. Then the files go out (below).
8. **Takedowns.** Log a takedown from the event. The clock starts, and the athlete goes do-not-publish at every event. Work each step from the desk.

### Clearing what posts on Pylon's channels

- **Before an approver clears anything, the app shows the event's keep-out list.** It lists every athlete who can't appear on Pylon's channels, by team and jersey number: a takedown, do-not-publish, no capture consent or no marketing consent.
- **The approver confirms that no one on the list appears in the pieces.** The database records who confirmed it and when. Nothing clears without it.
- From the desk, an approver can clear several events' pieces at once, with one confirmation after seeing each event's list.
- Any piece that posts can name the athletes it shows. Each named athlete is checked for capture and marketing consent. "Who Is ___?" features, interviews and tracked Top Performers must name theirs.
- Names on a piece that's already cleared are checked again whenever they change. Pieces that don't name athletes (the event report, say) don't take names.

### Clips to families and SportsClippers

- **The files come first.** Make the family-links file (directors) or the SportsClippers file (approvers) and hand it over. Then mark what went out.
  - "Mark sent" covers only clips that were in a family-links file.
  - "Mark listed" covers only clips that were in a SportsClippers file, at the visibility that file gave.
  - A clip exported as public whose guardian then turns public display off isn't marked. Make the file again and it goes up family-only.
  - A file belongs to the tags it was made under. A clip tagged again (by a director, or by a roster correction) goes out only in a new file, so a clip that went out as one athlete's is never marked sent as another's.
  - A full re-export of the SportsClippers file never lists a clip as more public than the app recorded.
- **A listing the roster stops allowing is pulled.**
  - Sale consent comes off: the clip has to come down. It shows under "out but can't stay".
  - Public display comes off, or the athlete turns out to be under 13: the listing goes family-only. An approver changes it on SportsClippers, then marks it here.
- **A clip on hold that's already out has to come down.** That covers a takedown, do-not-publish, withdrawn capture consent, or a roster change while it was out. Take it off SportsClippers and the family links, then mark it removed.
  - A clip held for a roster change goes back to tag review once it's down. It's matched again by its number where it can be; a director checks the rest.

### Takedowns

- **A takedown follows the athlete.** The Sports Thread roster ID is the same at every event, so the athlete goes do-not-publish everywhere at once.
  - That includes a stop whose roster loads later: the athlete starts there already held.
  - A later roster file can't clear it.
- **Everyone running an event the athlete is on sees it and is told about it,** in any region.
- **"Off every other surface" is done when nothing is out anywhere.**
  - Each director takes down their own region's clips. Marking the step in one region removes that region's family links and listings.
  - The app tells the other regions' directors what's still out.
  - The step closes when the last region is clear.

## QR codes and the stop page

Each event has a **QR codes** screen (from the event plan). It's the Campaign Builder's tracked links and QR codes, built for a stop.

- **The codes.** Every code opens the stop's public page, `/e/<event code>`. Each has its own tag, so its scans count apart.
  - **The stop:** for signs and the announcement graphic Pylon posts (Schedule J-5).
  - **Placements:** the booth, wristbands and team packets, plus any a director adds, like "Field 3 sign" (up to 20).
  - **Creators:** one per active adult creator invited or confirmed on the crew who has their own SportsClippers page, for their lanyard. An invited creator's code can be printed ahead; the page shows them once they're confirmed. A youth creator never gets a code and never appears on the page.
  - **A creator's SportsClippers page** is set on their record. A director can set it until Kyron records their screening; after that only Kyron changes it, as with their name and email.
- **Downloads.** Each code comes as a PNG (for posts) or SVG (for print shops), or as a printable letter-size sign or 4×6 lanyard card. "Copy" gives the link itself, for a bio or an email.
- **What the page shows.**
  - The stop's name, dates and place.
  - **Find your footage**, to the stop's page on SportsClippers. Until that link is saved, the page says the footage page isn't up yet. Printed codes still work, and the button appears once the link is in.
  - For a creator's code: their first name ("Ana is on the crew"), with their SportsClippers page.
  - How clips reach families: listed only with the permissions given at registration, and family-only by private link for an athlete under 13 or without public display.
  - Help: email Ground Floor Sports, text the on-site number if there is one, or reach the creator through SportsClippers. A takedown request goes by email. The page promises no time for it yet (see open questions).
- **The rules.**
  - The page never shows anything about an athlete. It reads no roster.
  - Links leave only for `sportsclippers.com`, and the database holds the same rule (migration 025).
  - Creators appear by first name only.
  - The page is Pylon's: Pylon's name and colors, with Ground Floor Sports as the crew and SportsClippers as the store. No TOJ or Subject marks.
  - System fonts only, so no font host learns who opened the page. It runs no scripts, can't be framed, and isn't indexed or cached.
- **Counts.**
  - Every scan of the page, and every click on to SportsClippers, counts against the code it came from.
  - Only the code and the day are kept, nothing about the visitor.
  - One address counts at most 300 times a minute, and one stop 2,000. The address is used only for that cap, in memory, through a key made fresh each time the server starts, and it's never stored or logged.
  - Someone calling the server directly, around Vercel, could still run the numbers up, so treat the counts as a guide.
  - Links on to SportsClippers carry `utm_source=pylon`, `utm_medium=stop_page`, `utm_campaign=<event code>` and `utm_content=<code>`, so SportsClippers' own reports can show which stop and code a sale came from.
- **Ready.** **Mark ready** ticks "QR code and storefront page" on the event plan.

## File formats

### The roster (Sports Thread export)

These columns are kept. Header names are matched loosely: case, spaces and punctuation don't matter. When a file has two candidates for the same field, the one higher in this list wins: with both "Athlete ID" and "Registration ID", the athlete ID is the roster ID.

| Kept as | Header names it accepts |
| --- | --- |
| roster ID (required) | Roster ID, Athlete ID, Player ID, Sports Thread ID, Participant ID, Registration ID, ID |
| team (required) | Team, Team Name, Team ID, Club |
| division | Division, Age Division, Age Group, Age Class, Bracket |
| jersey | Jersey, Jersey #, Jersey Number, Number, No, # |
| position | Position, Pos, Primary Position. Long names are shortened: Wide Receiver becomes WR. |
| under 13 | Under 13, U13 |
| permissions (Schedule F) | Capture; Recruiting Distribution; Marketing and Social; Sale of Media; Training Footage; 3D Scope; Narrative NFT; Pylon Scouting Feature |
| SportsClippers | Commercial; Public Display |
| flags | Do Not Publish (DNP); Low Profile; Priority or Player Package (pre-sold) |

How the values are read:

- **Every other column is dropped.** The app filters the file before it leaves the device, and the server drops anything else again. That covers names, birth dates, emails, phones, addresses, guardians, schools, hometowns and class years.
- **A permission is off unless the cell says yes** (yes, y, true, 1, x or ✓).
- **No capture column:** every athlete is held until one arrives.
- **Under 13:** an athlete counts as under 13 when the under-13 flag is missing or blank. A division with any number of 12 or less counts too, however it's written: 12U, U12, U-12, "Under 12", "12 & Under", "Girls U-10" (Schedule L-5).
- **A takedown stands.** A later roster file never clears it.
- **A correction re-tags.** When a later file gives an athlete a new jersey number or team, their clips may show someone else:
  - clips matched by number are matched again against the corrected roster;
  - clips a director tagged go back to tag review;
  - clips already out are held until they're taken down, then go back to tag review.
- **Athletes missing from a later file** are counted in the load summary. They keep the permissions they had. If a family withdrew, log a takedown.

### The upload log (GFS storage export)

One row per file. Columns:

- `path` (required);
- `uploaded_at`, either ISO with an offset or local `YYYY-MM-DD HH:MM` in the event's time zone;
- `creator`, the creator's code or email;
- `final_whistle`, for game files;
- `usable`, yes or no once the files are reviewed;
- `team`, optional.

Paths follow the Scout Agreement's Schedule B:

```
TEAM-A_vs_TEAM-B_YYYYMMDD/Sideline/TEAM-A_vs_TEAM-B_YYYYMMDD_Sideline.mp4    a game file
TEAM-A_vs_TEAM-B_YYYYMMDD/TEAM-A/11/11-EndZone-042.mp4                      a clip, with a team folder
TEAM-A_vs_TEAM-B_YYYYMMDD/00-unassigned/EagleEye-017.mp4                    a missed or non-graded play
```

- **A clip is matched only when its team is certain.** One of these has to be true:
  - a `team` column or a team folder names the team, the two agree, and the team is on the roster;
  - the game folder names two teams and both are on the roster (then the number has to belong to only one of them);
  - the roster has a single team.

  Anything else goes to tag review. That includes:
  - a game folder with a team name the roster doesn't use (`Buckeye-Flag` for "Buckeye Flag 12U");
  - a jersey folder and a file name that give different numbers (`7/11-Sideline-003.mp4`);
  - a `team` column naming a team that isn't in the game folder or on the roster.

  **Name game folders with the roster's team names.**
- **Team folders.** Schedule B-5 keeps one folder per jersey number per game, and that can't tell two teams' #11 apart. A team folder above the jersey folder settles it, and so does a `team` column. Without either, a number on both teams goes to tag review as *same number on both teams*.
- **Folder names and the team column.** Only jersey folders and `00-unassigned` are stored. A team folder, or a `team` column value, is kept only when it names one of the game's teams or a roster team. Any other name could be a person's, so it isn't stored, and the clip's key is a hash.
- **Labels.** A matched clip gets GFS's second-round label, `Event-Position-Jersey#-Angle-Clip#` (for example `Geneva2026-WR-11-EndZone-042`). Rows that don't follow the label standard are skipped, so a file named after a person never gets in.

### What leaves the app

- **The SportsClippers file** carries per clip:
  - the label and file;
  - the event;
  - the team, jersey, position and roster ID;
  - the angle;
  - the visibility (family or public);
  - the consent flags and the price.

  It never carries a name, a birth date or a contact (SportsClippers agreement §5). Only clips with sale-of-media consent are in it.
- **The family-links file** maps roster ID to that athlete's approved clips. The app sends nothing to families itself.

## A note on words

"Premier Event" is on the TOJ banned-word list. It is also the agreement's defined term for a Legacy Tour stop, so the app uses it only as that label and never in marketing copy.

## Open questions for Kyron

1. **Deliver follows Schedule C of the Pylon agreement (v11)**, not the "6 pieces per team" in pylon-os and the app-flow canvas. Schedule C is what GFS owes Pylon per event. Team packages are orders, and they stay in the XPAND dashboard (Schedule J-1). Keep it this way?
2. **Team folders.** Schedule B-5 should add a team folder (`GAME/TEAM/Jersey#/…`), or the upload tool should add a `team` column. Matching is now strict: without a team folder, a `team` column, or game folders spelled exactly like the roster's team names, clips go to tag review by hand.
3. **Regions.** The app uses the five pylon-os territories. The Scout Agreement's Schedule A has "[Central / East / West / Midwest]" in brackets. Which set is right?
4. **Josh Borne is an approver, not an owner.** He sees every region and clears work. Invites and creator screening stay with you.
5. **No first initial in the SportsClippers file.** The roster keeps no names, so none is sent, though §5 would allow a first name or initial. Keep it that way?
6. **Prices.** The clip price defaults to $19.99 (the v11 §8(d) example), and an approver can change it per event. A 4K price isn't in the paper yet.
7. **Takedown windows** come from pylon-os `config.md`: 2h/24h for a safety request, 24h/72h for withdrawn consent, and 24h to ask accounts Pylon doesn't run. That's stricter than the 72 hours in Section 11.
8. **Scorecards** need `final_whistle` and `usable` in the upload log. Family ratings are typed onto each crew member from SportsClippers' statements. Uploads and ratings count in the quarter the event ended in.
9. **The keep-out check is the approver's word.** Recaps, montages, stills and cut-downs show athletes nobody names, so the approver confirms against the list instead of the app checking each face. Is that the review Pylon wants under Schedule C-1 "Consent"?
10. **Athletes dropped from a later roster file** keep their old permissions, and the load summary counts them. Should the app hold them instead until someone checks?
11. **A takedown time on the page.** Section 8(b)(iii) of the draft Pylon agreement has content come down within 72 hours of a withdrawal. Once the help inbox is confirmed, and requests are logged as takedowns the day they arrive, should the page promise that?
12. **Packages on the stop page.** Schedule J-1 calls for a QR code and storefront page per stop for photo and video packages. pylon-os keeps the package storefront's brand off Pylon's surfaces, so the stop page links only to SportsClippers. Should it also link to the packages storefront?
13. **Credit for a creator's sales.** A creator's code tags the link on to SportsClippers with their code. Does SportsClippers credit a sale from that tag, or does the buyer still need to enter the creator's name as the referral (J-5 step 6)?
