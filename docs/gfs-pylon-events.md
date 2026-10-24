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

Code: `routes/gfs.js` (the API at `/api/gfs`), `utils/gfs.js` (the rules), `public/app/gfs.js` (the screens) and `db/migrations/024_gfs_events.sql` (the tables, plus the rules again as triggers).

## Who sees what

| Team role | In Pylon events | Sees | Can |
| --- | --- | --- | --- |
| Owner | Admin | Every region | Everything. Only the owner records creator screening and manages the team. |
| Approver | Approver | Every region | Clear what posts on Pylon's channels, approve clips, make the SportsClippers file and mark listings. Plus everything a director can do. |
| Member | Regional Director | Their regions | Plan events, crew them, load rosters and upload logs, tag clips, log deliverables, send work to approval, log and work takedowns, add creators. |
| Viewer | Viewer | Their regions | Read only. Never sees an athlete's permission flags or roster ID. |

Regions: West, South Central, Northeast, Southeast and Midwest (the pylon-os territories).

## Setting it up

1. **Apply migration 024 in Supabase**, with Kyron's OK. It adds `regions` to `team_members` and `team_invites` and creates the `gfs_*` tables.
   - Until it runs, the API answers `503 gfs_not_set_up`.
   - Everything else keeps working: sign-in reads the old columns if `regions` isn't there yet.
2. **Invite people.** In the app, go to Team → Invite and tick **Pylon events**.
   - **Regional Director:** pick Regional Director and at least one region.
   - **Approver** (Pylon's CEO, the Creative Lead): pick Approver. Approvers need no region.
   - The owner can change a director's regions later from Team → Change regions.
3. **Load the calendar.** An approver can go to Events → Load Pylon's calendar and choose `docs/gfs-calendar-2026-27.csv`.
   - It holds the 17 dated 2027 Legacy Tour stops from Schedule A-1 of the agreement and the three dated Girls Flag stops from A-4.
   - The National Championship has no location yet, so it isn't in the file.
   - Girls Flag is marked "[in scope / not in scope]" in A-4, and the file loads those stops as one-day tournaments.
   - Stops already in the app are skipped, so the file can be loaded again safely.
4. **Add creators** from Creators → Add. Kyron then records each creator's contract, background check and minor-safety training on their page. Until all three are on file, and each is less than a year old at the event, the creator can't be crewed.

## An event, start to finish

1. **New event.** Pick a size:
   - **Premier Event, One-Day Tournament or Clinic.** The size sets the Schedule C counts and the crew target (3, 2 or 1 on site).
   - **Dates, wrap time and time zone.** Every deadline runs from the wrap time on the last day, in the event's own time zone.
2. **Plan.** Four checks before the event:
   - QR code and storefront page (T-7);
   - roster and consent from Sports Thread (T-72h);
   - crew brief sent (T-48h);
   - crew confirmed, with a lead.
3. **Crew.** Assign from the region's pool. The rules:
   - A youth creator (16–17) shoots or shadows, never leads or edits.
   - A youth creator is confirmed only alongside a confirmed adult on site.
   - An adult can't be taken off if that would leave a youth creator alone.
4. **Roster.** Load the Sports Thread CSV.
5. **Live.** Load the upload log (the storage export). Game files feed the creator scorecards. Clips are tagged against the roster.
6. **Tag review.** Fix what didn't match, or mark it *not a player*. Then **approve the game's tags**: matched clips that aren't held move to the edit.
7. **Deliver.** This covers two things:
   - **Schedule C deliverables.** Log counts and send what posts on Pylon's channels to approval. An approver clears it or sends it back with a note.
   - **Clips.** Mark them edited. An approver approves them. Then export the family-links file, make the SportsClippers file and mark the clips listed.
8. **Takedowns.** Log a takedown from the event. The clock starts, and the athlete goes do-not-publish at every event. Work each step from the desk.

## File formats

### The roster (Sports Thread export)

These columns are kept. Header names are matched loosely: case, spaces and punctuation don't matter.

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
- **Under 13:** an athlete counts as under 13 when the under-13 flag is missing or blank, or the division is 12U or younger (Schedule L-5).
- **A takedown stands.** A later roster file never clears it.

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

- **Team folder.** Schedule B-5 keeps one folder per jersey number per game, and that can't tell two teams' #11 apart. A team folder above the jersey folder settles it, and so does a `team` column. Without either, a number on both teams goes to tag review as *same number on both teams*.
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
2. **Team folders.** Schedule B-5 should add a team folder (`GAME/TEAM/Jersey#/…`), or the upload tool should add a `team` column. Without one, overlapping numbers can't be matched automatically.
3. **Regions.** The app uses the five pylon-os territories. The Scout Agreement's Schedule A has "[Central / East / West / Midwest]" in brackets. Which set is right?
4. **Josh Borne is an approver, not an owner.** He sees every region and clears work. Invites and creator screening stay with you.
5. **No first initial in the SportsClippers file.** The roster keeps no names, so none is sent, though §5 would allow a first name or initial. Keep it that way?
6. **Prices.** The clip price defaults to $19.99 (the v11 §8(d) example), and an approver can change it per event. A 4K price isn't in the paper yet.
7. **Takedown windows** come from pylon-os `config.md`: 2h/24h for a safety request, 24h/72h for withdrawn consent, and 24h to ask accounts Pylon doesn't run. That's stricter than the 72 hours in Section 11.
8. **Scorecards** need `final_whistle` and `usable` in the upload log. Family ratings are typed onto each crew member from SportsClippers' statements.
