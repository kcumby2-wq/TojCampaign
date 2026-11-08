# Studio films: a room for every film

A Studio kit is the playbook (agents/studio, migration 018). A **film** is one piece of work made from it. Starting a film turns the kit's ten handoff steps into that film's steps, each with its owner, and the rules the kit asks people to follow by hand are held by the database (migration 039).

In the TOJ app: Studio → **Films**. API: `routes/studio-films.js` (team) and `routes/studio-review.js` (the speakers' links). Template: `agents/studio/films.js`. The craft screens (shoot mode, the ghost frame, the delivery check, the graphics) are `public/app/film-craft.js` (migration 040).

## The ten steps

From the Same Work kit's *Handoffs and checklists* column, in its order. One step at a time; the database refuses a step before the one ahead of it.

| Step | Owner | Done when |
|---|---|---|
| Brief | Producer | The director can say the story back in one sentence (the film needs its one-sentence story) |
| Board | Director | The producer can fill the clearance card |
| Clearance card | Producer | **No card, no shoot**: everyone on camera has a cleared card |
| Shoot | Director | Cards copied twice; everyone still cleared |
| Selects | Director | The editor can cut without calling the director |
| Rough cut | Editor | The review copy is uploaded with everyone in it listed |
| Speaker review | Producer | Every speaker in the cuts that go on said yes to those exact files (the producer names the cuts: a hero film's 9:16 and its 4:5, say) |
| Rights check | Producer | What's on screen in those cuts matches each release |
| Final sign-off | Producer and Coach Hooks | Both say yes, or it waits. The producer records Hooks's yes and how it came, once the rights check is done |
| Publish | Kyron | Every post recorded, so a takedown can find it |

*Producer* means an approver or Kyron. The film's director and editor (assigned by the producer) finish their own steps; the producer can finish any step but Publish. The checklists (*Shoot day: director*, *Edit delivery: editor*, *Release: producer*) are read from the approved kit, so a kit refresh updates them.

The rights check and the final sign-off are for the cuts the speaker review named, and **only those cuts are posted**: a cut approved after the sign-off waits for the steps to run again. The producer can reopen the last done step (and so walk back), with a reason. Walking back past the rights check takes Hooks's yes with it (it was for the cuts as they were). A film with anything live isn't walked back (take the posts down first), a published film is never reopened (it's taken down), and a closed film isn't reopened at all.

Each change to a film takes the film's lock first, so two changes that are each allowed alone can't both land: a post recorded while consent is being pulled waits for the pull, then is refused. The order is always the same: the person code (a card being added, a pull), then films in id order, then the film's rows, then takedowns in id order (a post's line coming down takes the post down, which ticks that post's line on every other takedown listing it, so all of them are locked up front). A change to a single row that a cascade can also reach (a card, a step, a review link, a post, a takedown line) goes through a database function that takes the film first. If two changes still collide in the same instant, the database rolls one back and the server tries it once more.

## Clearance cards

One per person on camera. The name stays on the card; everything else carries the **code** (the athlete ID; a parent adds `-P1`). The same person has the same code in every film: that's how a pulled consent finds them all.

- What the release covers: face, name, jersey, voice, and which formats.
- **Every minor is unidentifiable**: no face, no name, no jersey number (Kyron's rule; the kit's for Texas youth, who are minors until counsel clears otherwise). The form and the database both hold this.
- A **speaker** (their words are in the film) approves the cut: an adult themselves, a minor's parent or legal guardian.
- The producer clears a card. Changing a cleared card clears it again. A card in something live doesn't change or get uncleared at all (take the post down, or pull consent).
- **Who approves** (the reviewer's name, email and relation) is the producer's to change. Any change to a card stops its live review links, and an approval counts only from the reviewer the card names now: an adult's own yes stops counting if the card is corrected to a minor whose parent approves.
- Titles, file names and the one-sentence story never carry a name: the app refuses one that contains a card's name (a word of three letters or more, the whole name, or the name run together as one word, as in `JamieRivers`), or a word of a minor's name, two letters or more ("Bo"). A word of a minor's name that's also an everyday word ("he" in Bo He, "will", "hope", "field", "young": the app keeps the list) counts only as a name: with a capital in the middle of a sentence ("talked to Will after"); in lower case it's the everyday word, and "He runs it now" is fine. An adult's lone two-letter name isn't caught.
- Notes are screened the same way, with one difference: a single word of an adult's name ("will" for a Will, "mark" for a Mark), or a minor's everyday-word name at the start of a sentence ("Will you send it?"), is asked about, and kept once the writer says that word isn't a name here (the app sends back the exact words, for that exact text; change the text and it asks again). A whole name, one run together, or any other word of a minor's name is always refused, by the app and by the database: there's no "it isn't a name here" for a child. (The database leaves the everyday words to the app.)
- **A pulled consent stays pulled.** A new card for that code is refused while its takedown is open, and after that until the producer records the family's new consent (how and when) on the first new card. A card being added while the pull runs waits for it, and is pulled with it.

## Cuts, the clip log and review links

An editor uploads a review copy (720p is plenty; up to `STUDIO_REVIEW_MAX_MB`, 50 MB by default, which is also Supabase's free-plan limit) and ticks everyone in it. **That list is the clip log** a takedown follows. The file goes straight to the private bucket `studio-films`; the worker (`utils/studio-review-worker.js`, ffmpeg) makes the copy speakers watch, at 720 on the short side, with its sound and *REVIEW COPY · NOT FOR SHARING* burned in. It takes the uploaded file's sha256 (the file that will post; every approval is for it) and the copy's own sha256, whose start names the copy in storage: a copy is never overwritten, and neither fingerprint changes once the cut is ready. Nothing is made for a pulled or archived film, and whatever the worker made for a cut that didn't make it is taken back out.

The producer sends each speaker in the cut their link (`/film-review.html#t=…`, 7 days, one use). Like the Concierge's family approvals (migration 037), the token stays in the link's fragment, the server sends the database its proof, and the table keeps only the proof's hash: nobody who can read the table can answer for the speaker. The approval is for that exact file, from the reviewer the card names. A *change* answer needs a note and goes to the producer and the film's editor; the reviewer gets a receipt either way. If the email fails, the link is taken back. Replies go back to the reviewer (or `STUDIO_REVIEW_REPLY_TO`, an address nobody reads), never to staff: a reply quotes the link.

Live links sit in more places than the app:
- with Gmail as the app's mail account, the **Sent folder** keeps a copy of every review email, links included: whoever can open that account can see live links. Some sending services keep message bodies for days too (Postmark and Mailgun do): check yours, and keep whichever account sends to Kyron;
- a **bounced** review email usually comes back whole, link included, to the sending account. The speaker never got it: **Cancel link** on that cut, check the address on the card, and send a new one.

Once a link is out, who's in the cut is fixed. A speaker who takes their yes back is recorded by the producer ("They took it back"); that cut can't go out (a live post has to come down first).

### Stills and slides

A parent card (one photo), a quote card or an In Their Own Words carousel goes to its speaker like a cut: **Upload a cut for review** takes 1 to 10 images (PNG or JPEG, 20 MB each) in order, or the graphics screen sends its slides. The speaker sees copies marked *REVIEW COPY*, at 1080 on the long side and without the photo's metadata (a phone photo's location stays out), and approves the files themselves: the set's fingerprint is the sha256 of each file's sha256, in order. The copies sit in a folder named by their own fingerprint, so none is ever overwritten. Each slide is one still that shows what will post: an opaque PNG or a JPEG, 3000 pixels a side at most (a canvas export's unused alpha is fine). A PNG with see-through parts, or an animated one, is refused with what to do, since the copy would show something else than the file. Sets are for the formats the kit makes as stills (a parent card, a quote card, a carousel), in that format's ratios. A set that's refused when it's registered, or more slides uploaded than registered, leaves nothing behind. A set made with the graphics system needs that system approved first, and the database holds it: while it's off, no set made with it is kept, no review link goes out for one, and turning it off stops their live links. Its PNGs carry the app's mark, so they can't come back as an "upload" while it's off. Uploads from the editor's own tools need only *Review copies in storage*.

### Notes on a cut

Under each cut: a note for the edit, at the playhead (`0:12`) or for the whole cut, with an optional **label** in the same few words each time it comes up ("open on the fact", "music under the voice"). Labels count across films; one that comes up three times is a rule in the making (the kit's monthly refresh, next PR). The film's editor sees open notes on Today and marks each one done (the producer can too). Notes are kept for good, so they carry no names (the app and the database both refuse one); a label is shared by every film, so it's checked against every film's cards. A cut that was never reviewed or posted can still be deleted when it has notes: the notes stay, with what the cut was ("hero 9x16 v1").

## On set and in the edit

**Shoot mode** (the room → *Shoot mode*): the shoot day, the call times, where, and a light for every card (green cleared, red not: "shoot B-roll that doesn't show them, and call the producer"). Minors read "wide shots only". Below that: the three must-haves, the frame pair, and the kit's own cards for the day (*Minors on set*, open whenever a minor is on the cards; *Thirteen interview rules*; *Run the day*; the Same Drill or new-format card when the film is one), read from the approved kit as plain text. Then the *Shoot day: director* checklist. Ticks stay on the phone. The phone keeps a copy of the sheet for a dead signal: the times, the codes and the lights, the kit's cards, and only those lines of the board with no name, contact or place in them (a line that reads like a name or a place, "Dana Whitfield brings the sled", shows as "details online only"). The board itself refuses a card's name, a phone number, an email, a link or a street address in the call times, the must-haves and the frame pair (places go under *Locations*, which never leave the server). A saved copy is shown for 14 days at most, 10 films at most, and signing out removes every sheet, tick and graphics draft from the phone.

**The ghost frame** (Same Drill films, from shoot mode): the archive frame, picked from the phone, see-through over the live camera, with thirds and a horizon line, to match the angle, height, side and direction; then the kit's three ways (matched, tighter, wider) to tick. Nothing is recorded or uploaded. Where the app can't open the camera, a test shot goes under the frame instead.

**The delivery check** (the room → *Delivery check*): pick the export; the phone reads its size, shape and length (the file stays on the phone) and the server checks them against the kit. The checks: the format's ratios, 1080×1920 for 9:16 and 1080×1350 for 4:5, the format's length, no names in the file name (a failure), and the kit's name pattern (a warning). Checks are kept for the film; a file name with a name in it is kept as "(a file name with a name in it)".

**The graphics** (the room → *Graphics*), in the kit's proposed type system: Playfair Display for headlines and quotes (one word in italic), Oswald caps widely tracked for title cards, Courier Prime for letters; one accent, cream (`#EFE3C8`), on dark frames.
- *Quote card* (4:5 or 9:16): their own line, word for word from the transcript; two or three more sentences from the same answer; the credit only as far as the release allows (a minor's, or a card that doesn't cover the name, reads "A Coached by Hooks athlete"); optionally a real, cleared photo, with a tick that everyone in it is listed and it shows only what their cards allow.
- *In Their Own Words*: the quote card, then letter slides (one idea each; a blank line starts the next), 5 to 7 in all, page numbers on each.
- *Title card*, *end card* (a type stand-in for the Coached by Hooks mark) and *year labels* (transparent, small in the top corner, with a tick that the years are true): saved for the edit, not reviewed.

Before a graphic is saved or sent, the server checks its words and its credit by the same rules as titles and file names: a name the release doesn't let a graphic carry on that format (any word of a minor's name, a child's name run together as in `#TyNg`, a parent's or guardian's name ever), or a word on the TOJ banned list, holds it back. The credit names a speaker only if they're an adult, cleared, and their release covers their name and lists the format. A closed film makes no graphics. Drafts stay in this session only, for a day at most. Until Kyron and Coach Hooks turn on *The graphics system*, every graphic carries a **PROPOSED** band and nothing goes to review; the screen reads the switch afresh before saving or sending. The fonts are in `public/app/fonts` (SIL Open Font License, `OFL.txt`) and cached with the app.

## Posting and takedowns

Only Kyron records posts, after the final sign-off, and only cuts every speaker in them approved, with everyone in them cleared.

**Consent pulled** (the producer, from the card): every card with that code is closed, every film they're in is pulled for good, live review links stop, and a takedown opens with a line for every live post plus one for everything outside the app (drives, the Milanote board, the editor's machine). **The 72-hour clock** starts at once and shows on Today. Marking a line down takes its post down; the last line closes the takedown.

The files of those films (uploads, review copies, posters) are listed for removal by the database in the same change, and removed at once; anything storage refuses is tried again on the worker's next pass (`studio_storage_removals`). A deleted cut's files go the same way, and so do any the worker made for a cut that didn't make it. For three hours after a pull, the worker also empties the pulled film's whole folder on every pass (every pulled film, newest pull first, a page at a time): an upload link made just before the pull (they last two hours) can still land a file no row lists. A file in that folder that storage won't remove goes on the removal list, so it's tried again after the three hours; a folder storage won't list is looked at again on the next pass. The same pass closes any takedown with nothing left on it, one at a time, leaving one that someone is changing right now for the next pass.

A takedown's lines lock the takedown as they're marked down, so the last line always closes it; the worker closes any takedown with nothing left on it, as a safety net.

## Tool approvals

The kit's rule: a tool touches footage only once the producer has checked its terms and added it, with a one-line reason. Three switches start **off**; only Kyron turns them on, and the reason is kept:

- **Review copies in storage**: needed for uploads and review links. Turning it off stops every live link.
- **Claude reads transcripts**: for the real-words tools (next PR).
- **The graphics system**: once Kyron and Coach Hooks approve the type system (next PR).

## The history

Every step, card, cut, review, post, takedown and switch is written to `studio_events` by the database itself (a trigger running as the tables' owner, which no API session can be) and never changed. Staff add notes.

**No names go in it**, or in the team activity log. A reviewer is written as who they are to the speaker ("their parent"), and a change note stays on the review, not in the history. A staff note (a step, a reopen, Hooks's yes, a pull, a takedown line) that names someone on the film's cards is refused by the app (or asked about, for a single word of an adult's name), and the database leaves out any note with a whole name, a run-together one or any word of a minor's name regardless. Who makes a change says so with that change (`changed_by` is taken by the database with each write, never carried over from the last one).

Every Studio table refuses `TRUNCATE`, and the server's role (`service_role`) can read and write rows only: it can't empty a table, put a trigger on one, or point a foreign key at one.

## Endpoints

All under `/api/studio-films` (team members with Studio; writes are JSON from the app's own pages):

| Method | Path | Who |
|---|---|---|
| GET | `/meta`, `/today`, `/films`, `/films/:id` | members |
| POST | `/films` | members (the producer assigns director and editor) |
| PATCH | `/films/:id` (with `seen`) | members |
| POST | `/films/:id/archive`, `/films/:id/second-yes`, `/films/:id/steps/:step/reopen` | producer |
| POST | `/films/:id/steps/:step/done` (Speaker review: `{ cut_ids }`) | the step's owner or the producer (Publish: Kyron) |
| POST/PATCH/DELETE | `/films/:id/people[/:pid]` | members (who approves, and a new consent: the producer) |
| POST | `/films/:id/people/:pid/clear`, `/people/pull` | producer |
| POST | `/films/:id/cuts/upload`, `/films/:id/cuts`; PATCH/DELETE `/films/:id/cuts/:cid` | members |
| POST | `/films/:id/cuts/:cid/reviews`, `/reviews/:rid/cancel-link`, `/reviews/:rid/withdraw` | producer |
| POST | `/films/:id/posts` | Kyron |
| POST | `/posts/:pid/removed`, GET `/takedowns`, POST `/takedowns/:tid/items`, `/takedown-items/:iid/done` | producer |
| POST | `/tools/:tool` `{ on, note }` | Kyron |
| GET | `/films/:id/shoot`, `/labels` | members |
| POST | `/films/:id/cut-notes` `{ cut_id, at_ms, note, label }` | members |
| POST | `/cut-notes/:nid/resolve` | the film's editor, the producer |
| POST | `/films/:id/graphics/check` `{ texts, speaker_id, credit, format }` | members |
| POST | `/films/:id/delivery-checks` `{ file_name, format, ratio, duration_ms, width, height, bytes }` | members |
| POST | `/films/:id/slides/upload`, `/films/:id/slides` `{ format, ratio, version, file_name, people, slides, made_with }` | members |

The speakers' page: `POST /api/studio-review/view {token}` and `POST /api/studio-review/decide {token, decision, name, note, confirm}` (POST and JSON only, from the site's own pages, 30 tries per visitor per 10 minutes).

## Setup

1. Apply `db/migrations/039_studio_films.sql` (tables, rules, the bucket `studio-films`), then `040_studio_craft.sql` (notes, delivery checks, stills and slides).
2. Optional settings on Render: `STUDIO_SITE_BASE` (default `https://www.tojcampaign.com`), `STUDIO_REVIEW_REPLY_TO`, `STUDIO_REVIEW_MAX_MB` (raise it after the Supabase Pro upgrade), `STUDIO_REVIEW_WORKER=off` to stop the worker on a server.
3. Kyron turns on *Review copies in storage* (Studio → Films → Tool approvals) once he's checked Supabase's terms.
4. Email works as for the rest of the app (`EMAIL_USER`/`EMAIL_PASS` or `SMTP_*`); without it, review links aren't made.

## Known limits

- The kit names only some file codes (YTH, HERO in its example). The other lane and format codes (`NFL`, `COL`, `PAR`, `CUT`, …) are the app's until the kit names them; the file-name check only warns.
- Coach Hooks's yes is recorded by the producer with how it came (a text, an email), not by Hooks in the app.
- The worker reads a review copy into memory to upload it (a 10-minute copy at 720p is tens of megabytes).
- The speakers' page limits tries per visitor by `X-Forwarded-For`, which a caller reaching Render directly can set. The per-connection limit and the 256-bit tokens still hold.
- If the phone closes the app with no signal, the app opens at sign-in until there's a signal again: open shoot mode before the signal goes.
- The end card is a type stand-in until the Coached by Hooks mark file is added to the app.
- The graphics read the speaker's line as typed: the real-words tools (next PR) will offer lines straight from the transcript.
- The phone's copy of the shoot sheet drops lines that read like a name or a place by their capitals; a name typed all in lower case, of someone not on the cards, can't be told from other words. Keep names on the cards.
- A two-letter name run together ("tyng") is caught on graphics for a minor, but not in notes, where the database's screen starts at five letters.
