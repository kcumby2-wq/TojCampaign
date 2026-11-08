# Studio films: a room for every film

A Studio kit is the playbook (agents/studio, migration 018). A **film** is one piece of work made from it. Starting a film turns the kit's ten handoff steps into that film's steps, each with its owner, and the rules the kit asks people to follow by hand are held by the database (migration 039).

In the TOJ app: Studio → **Films**. API: `routes/studio-films.js` (team) and `routes/studio-review.js` (the speakers' links). Template: `agents/studio/films.js`.

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
| Speaker review | Producer | Every speaker in the cut said yes to that exact file |
| Rights check | Producer | What's on screen matches each release |
| Final sign-off | Producer and Coach Hooks | Both say yes, or it waits (the producer records Hooks's yes and how it came) |
| Publish | Kyron | Every post recorded, so a takedown can find it |

*Producer* means an approver or Kyron. The film's director and editor (assigned by the producer) finish their own steps; the producer can finish any step but Publish. The checklists (*Shoot day: director*, *Edit delivery: editor*, *Release: producer*) are read from the approved kit, so a kit refresh updates them. The producer can reopen the last done step (and so walk back), with a reason; a published film is never reopened: it's taken down.

## Clearance cards

One per person on camera. The name stays on the card; everything else carries the **code** (the athlete ID; a parent adds `-P1`). The same person has the same code in every film: that's how a pulled consent finds them all.

- What the release covers: face, name, jersey, voice, and which formats.
- **Texas youth athletes** are minors and unidentifiable until counsel clears it: no face, no name, no jersey number. The form and the database both hold this.
- A **speaker** (their words are in the film) approves the cut: an adult themselves, a minor's parent or legal guardian.
- The producer clears a card. Changing a cleared card clears it again; a card in something live can't change (pull consent instead).
- Titles and file names never carry a name: the app refuses one that contains a card's name.

## Cuts, the clip log and review links

An editor uploads a review copy (720p is plenty; up to `STUDIO_REVIEW_MAX_MB`, 50 MB by default, which is also Supabase's free-plan limit) and ticks everyone in it. **That list is the clip log** a takedown follows. The file goes straight to the private bucket `studio-films`; the worker (`utils/studio-review-worker.js`, ffmpeg) makes the copy speakers watch, at 720 on the short side, with its sound and *REVIEW COPY · NOT FOR SHARING* burned in, and takes the file's sha256.

The producer sends each speaker in the cut their link (`/film-review.html#t=…`, 7 days, one use). Like the Concierge's family approvals (migration 037), the token stays in the link's fragment, the server sends the database its proof, and the table keeps only the proof's hash: nobody who can read the table can answer for the speaker. The approval is for that exact file. A *change* answer needs a note and goes to the producer and editor; the reviewer gets a receipt either way. If the email fails, the link is taken back. Replies go back to the reviewer (or `STUDIO_REVIEW_REPLY_TO`, an address nobody reads), never to staff: a reply quotes the link.

Once a link is out, who's in the cut is fixed. A speaker who takes their yes back is recorded by the producer ("They took it back"); that cut can't go out (a live post has to come down first).

## Posting and takedowns

Only Kyron records posts, after the final sign-off, and only cuts every speaker in them approved, with everyone in them cleared.

**Consent pulled** (the producer, from the card): every card with that code is closed, every film they're in is pulled for good, live review links stop, the review copies of those films leave storage, and a takedown opens with a line for every live post plus one for everything outside the app (drives, the Milanote board, the editor's machine). **The 72-hour clock** starts at once and shows on Today. Marking a line down takes its post down; the last line closes the takedown.

## Tool approvals

The kit's rule: a tool touches footage only once the producer has checked its terms and added it, with a one-line reason. Three switches start **off**; only Kyron turns them on, and the reason is kept:

- **Review copies in storage**: needed for uploads and review links.
- **Claude reads transcripts**: for the real-words tools (next PR).
- **The graphics system**: once Kyron and Coach Hooks approve the type system (next PR).

## The history

Every step, card, cut, review, post, takedown and switch is written to `studio_events` by the database itself (a trigger running as the tables' owner, which no API session can be) and never changed. Staff add notes. No names go in it, or in the team activity log.

## Endpoints

All under `/api/studio-films` (team members with Studio; writes are JSON from the app's own pages):

| Method | Path | Who |
|---|---|---|
| GET | `/meta`, `/today`, `/films`, `/films/:id` | members |
| POST | `/films` | members (the producer assigns director and editor) |
| PATCH | `/films/:id` (with `seen`) | members |
| POST | `/films/:id/archive`, `/films/:id/second-yes`, `/films/:id/steps/:step/reopen` | producer |
| POST | `/films/:id/steps/:step/done` | the step's owner or the producer (Publish: Kyron) |
| POST/PATCH/DELETE | `/films/:id/people[/:pid]` | members |
| POST | `/films/:id/people/:pid/clear`, `/people/pull` | producer |
| POST | `/films/:id/cuts/upload`, `/films/:id/cuts`; PATCH/DELETE `/films/:id/cuts/:cid` | members |
| POST | `/films/:id/cuts/:cid/reviews`, `/reviews/:rid/cancel-link`, `/reviews/:rid/withdraw` | producer |
| POST | `/films/:id/posts` | Kyron |
| POST | `/posts/:pid/removed`, GET `/takedowns`, POST `/takedowns/:tid/items`, `/takedown-items/:iid/done` | producer |
| POST | `/tools/:tool` `{ on, note }` | Kyron |

The speakers' page: `POST /api/studio-review/view {token}` and `POST /api/studio-review/decide {token, decision, name, note, confirm}` (POST and JSON only, from the site's own pages, 30 tries per visitor per 10 minutes).

## Setup

1. Apply `db/migrations/039_studio_films.sql` (tables, rules, the bucket `studio-films`).
2. Optional settings on Render: `STUDIO_SITE_BASE` (default `https://www.tojcampaign.com`), `STUDIO_REVIEW_REPLY_TO`, `STUDIO_REVIEW_MAX_MB` (raise it after the Supabase Pro upgrade), `STUDIO_REVIEW_WORKER=off` to stop the worker on a server.
3. Kyron turns on *Review copies in storage* (Studio → Films → Tool approvals) once he's checked Supabase's terms.
4. Email works as for the rest of the app (`EMAIL_USER`/`EMAIL_PASS` or `SMTP_*`); without it, review links aren't made.

## Known limits

- The kit names only some file codes (YTH, HERO in its example). The other lane and format codes (`NFL`, `COL`, `PAR`, `CUT`, …) are the app's until the kit names them; the file-name check only warns.
- Coach Hooks's yes is recorded by the producer with how it came (a text, an email), not by Hooks in the app.
- Slides (In Their Own Words, quote cards) go through the same review links once the graphics templates land (next PR).
