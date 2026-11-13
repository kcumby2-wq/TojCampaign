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
- Titles and file names never carry a name, and they're read harder than sentences:
  - words that run together are split first (`TyNgQuoteCard`, `hope_quote_v02`);
  - any word of a card's name counts, in any case, an everyday word too ("hope", "smith"): a word of three letters or more, two for a minor ("Bo"), but never a two-letter everyday word ("in", "an");
  - a name run together counts anywhere inside a word (`tyngquotecard`), from five letters (four for a minor).
  - one word of a minor's name (four letters or more) run into another word counts where the letters on each side of it are English words or nothing (`#jordanfootball`, `#letsgojamie`, `#bigjamieenergy`, "Jordanfootball season", a possessive s too: `#jordansarmy`), beside a word a tag or a file name runs a name into (`jordanquote_v2`, `quotejordan`, "Kiddstrong season", `#teamjordan`), beside initials in a tag or a handle (`kayleeb_hoops`), or where camelCase starts or ends it (`JordanStrong`), and in a file name, which has no one to ask, wherever a word starts or ends (`jordanxyz_v2`). An English word that holds a name's letters is the word, asked about where questions can be asked and never refused, a file name's too: "island" for an Isla, "transfer" for a Tran, "basically" for an Ally, "Philadelphia" for a Phil, `#merrychristmas` for a Chris, `#islandlife` (the app reads English from SCOWL's list, `utils/data`; a run of more than 140 letters isn't read as words, and a name in it is asked about; a name with a plural's s keeps its own reading, `#angelsquad`). Anything else is asked about (`#jordanbae`). An everyday word counts that way only as a first name beside a word that says so (`#hopestrong`, `#teamhope`), while beside a word that's as often a phrase (`#summertime`, `#faithlife`), as a surname (`#teamgreen` for an Ava Green), or in a title ("Summertime grind"), it's asked about; it counts in a file name beside a word file names use (`hopequote_v02`, `teamhope`; `hopeful_promo` and `kicking_drill` are ordinary words), and so does a three-letter one (`samquote_v2`, "samstrong"; a title like "Teamsam" is asked about; `same_drill` is the word). Editing words made that way are words (`blackframe`, `whitecard`, `shortcut`).
  - A title is words someone chose, so two of those are asked about there rather than refused: an everyday word that's also a name ("Game day" for a Dan Day, "Young and hungry" for a Chase Young), and a short name run together inside a word ("The walkout" for an Al Ko). The title is kept once the writer says it isn't a name here. A name run together from a word's start, or of seven letters or more, is still refused, and so is a minor's everyday-word name read as in a story: a possessive ("Hope's first season") or a capital mid-title outside Title Case ("Go Hope go", "Thanks, Hope").
  - A title or story sent unchanged (the edit screen sends both with every save) isn't asked about again, but a certain name in it still stops the save. The database holds the certain ones too (a whole name, one run together, any word of a minor's name), so a title and a card saved in the same instant can't both go through. A card added or changed later is read against both: a name from the film's cards in either stops the card until they change, and an everyday word that's also its name is asked about there.
- The one-sentence story is a sentence: it never carries a card's name (a word of three letters or more, two for a minor, the whole name, or the name run together as one word, as in `JamieRivers`). A card with a middle name ("Grace Ann Long") is read by its first and last name too ("Grace Long", `#GraceLong`, `gracelong_quote_v1`), here and everywhere a whole name is read, by the app and by the database. So a first and last name that make an everyday phrase are refused as a two-word name would be ("rose gold" for a Rose Ann Gold, "will power" for a Will Henry Power): write it another way. A word that's also an everyday word ("he" in Bo He, "will", "hope", "field", "young": the app keeps the list) counts as a name with a capital in the middle of a sentence ("we ran it with Will"). At the start of a sentence ("Hope never quits") the app asks, and keeps it once the writer says it isn't a name here. In lower case it's the everyday word. An adult's lone two-letter name isn't caught.
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

A parent card (one photo), a quote card or an In Their Own Words carousel goes to its speaker like a cut: **Upload a cut for review** takes 1 to 10 images (PNG or JPEG, 20 MB each) in order, or the graphics screen sends its slides. The speaker sees copies marked *REVIEW COPY*, at 1080 on the long side and without the photo's metadata (a phone photo's location stays out), and approves the files themselves: the set's fingerprint is the sha256 of each file's sha256, in order. The copies sit in a folder named by their own fingerprint, so none is ever overwritten. Each slide is one still that shows what will post: an opaque PNG or a JPEG, 3000 pixels a side at most (a canvas export's unused alpha is fine). A PNG with see-through parts, or an animated one, is refused with what to do, since the copy would show something else than the file. Sets are for the formats the kit makes as stills (a parent card, a quote card, a carousel), in that format's ratios. A file that can't be read whole (cut short, two headers, a header after the pixels, a JPEG's second frame before its end) is refused, and so is a 16-bit PNG with an alpha channel (export it at 8 bits, flattened). A set that's refused when it's registered, or more slides uploaded than registered, leaves nothing behind; a registration naming an id another cut already has is refused (`id_taken`) and that cut's files stay. A set made with the graphics system needs that system approved first, and the database holds it: while it's off, no set made with it is kept, no review link goes out for one, and turning it off stops their live links (a link being written at that moment is waited for, then stopped too). Turning it off takes those films first, in the order a link or a decision takes them, so the two never deadlock: the server changes a switch only through `studio_tool_switch` (it can't update the switches itself). If a speaker opens such a link anyway, the page says the review is paused, and no decision is recorded. Its PNGs carry the app's mark, so they can't come back as an "upload" while it's off. Uploads from the editor's own tools need only *Review copies in storage*.

### Notes on a cut

Under each cut: a note for the edit, at the playhead (`0:12`) or for the whole cut, with an optional **label** in the same few words each time it comes up ("open on the fact", "music under the voice"). Labels count across a kit's films; one that comes up three times is a rule in the making (the kit's monthly refresh, below). The film's editor sees open notes on Today and marks each one done (the producer can too). Notes are kept for good, so they carry no names (the app and the database both refuse one); a label is shared by every film, so it's checked against every film's cards. A cut that was never reviewed or posted can still be deleted when it has notes: the notes stay, with what the cut was ("hero 9x16 v1").

## On set and in the edit

**Shoot mode** (the room → *Shoot mode*): the shoot day, the call times, where, and a light for every card (green cleared, red not: "shoot B-roll that doesn't show them, and call the producer"). Minors read "wide shots only". Below that: the three must-haves, the frame pair, and the kit's own cards for the day (*Minors on set*, open whenever a minor is on the cards; *Thirteen interview rules*; *Run the day*; the Same Drill or new-format card when the film is one), read from the approved kit as plain text. Then the *Shoot day: director* checklist. Ticks stay on the phone. The phone keeps a copy of the sheet for a dead signal: the call times without what they're for, the codes and the lights, the kit's cards, and only those must-haves and frame-pair lines (and the title) that a strict screen can't fault:
- no word of a card's name, in any case (an everyday word too: "hope smiling");
- no word of a place under *Locations*, in any case;
- no phone number, email, link, address, "@" or digit;
- no capital after the first word ("Wide at Westlake HS", "St. Mary's gym"), and a capital first word only if it's an ordinary one or a word the approved kit itself uses ("Hands", "Gate", not "Dana" or "Lincoln"). The rest shows as "details online only" on the saved copy; online, a line the phone won't keep says so. The board itself takes what's typed: it's a call sheet, and a card added later never blocks an edit. The board's screen says which lines go on the phone. A saved copy is shown for 14 days at most, 10 films at most, and signing out removes every sheet, tick and graphics draft from the phone.

**The ghost frame** (Same Drill films, from shoot mode): the archive frame, picked from the phone, see-through over the live camera, with thirds and a horizon line, to match the angle, height, side and direction; then the kit's three ways (matched, tighter, wider) to tick. Nothing is recorded or uploaded. Where the app can't open the camera, a test shot goes under the frame instead.

**The delivery check** (the room → *Delivery check*): pick the export; the phone reads its size, shape and length (the file stays on the phone) and the server checks them against the kit. The checks: the format's ratios, 1080×1920 for 9:16 and 1080×1350 for 4:5, the format's length, no names in the file name (a failure, read as titles are: split where words run together, any word of a card's name in any case), and the kit's name pattern (a warning). Checks are kept for the film; a file name with a name in it is kept as "(a file name with a name in it)", and the database splits run-together words before it looks too.

**The graphics** (the room → *Graphics*), in the kit's proposed type system: Playfair Display for headlines and quotes (one word in italic), Oswald caps widely tracked for title cards, Courier Prime for letters; one accent, cream (`#EFE3C8`), on dark frames.
- *Quote card* (4:5 or 9:16): their own line, word for word from the transcript; two or three more sentences from the same answer; the credit only as far as the release allows (a minor's, or a card that doesn't cover the name, reads "A Coached by Hooks athlete"); optionally a real, cleared photo, with a tick that everyone in it is listed and it shows only what their cards allow.
- *In Their Own Words*: the quote card, then letter slides (one idea each; a blank line starts the next), 5 to 7 in all, page numbers on each.
- *Title card*, *end card* (a type stand-in for the Coached by Hooks mark) and *year labels* (transparent, small in the top corner, with a tick that the years are true): saved for the edit, not reviewed.

Before a graphic is saved or sent, the server checks its words and its credit by the same rules as titles and file names: a name the release doesn't let a graphic carry on that format (any word of a minor's name, a child's name run together as in `#TyNg`, a parent's or guardian's name ever), or a word on the TOJ banned list, holds it back. A graphic is public, so hashtags and handles are read too:
- capitals in a tag's run are split apart (`#TyNgNeverQuit` reads "Ty Ng Never Quit"), and every word of a tag, like every word of a line of three words or more in Title Case or capitals ("Never Lose Hope"), reads as the start of a sentence: a capital there says nothing, so an everyday word that's also a name is asked about (`#HopeIsAPlan`, `#NeverLoseHope`), and a whole name is still a name (`#HopeFieldStrong`);
- a name run together is a name where a word of the tag starts or ends, or at seven letters or more (`#tyngneverquit`, `@tyng23`, `#GoTyNg`, `#teamtyng`, `#gojordankidd`);
- a shorter one inside a word of the tag is asked about (`#SpeedLimit` for an Ed Li, `#WalkOff` for an Al Ko);
- one word of a minor's name (four letters or more) run into a tag or a word is the name where the letters on each side are English words or nothing, beside a tag's or a file's own word, or where camelCase starts or ends it (`#jordanstrong`, `#teamjordan`, `#jordanfootball`, `#letsgojamie`, "jordanstrong forever", `#hopestrong` for a Hope); an everyday word beside a phrase's word or as a surname is asked about (`#summertime`, `#teamgreen`), and so is an English word that holds a name ("island" for an Isla, `#Philadelphia` for a Phil, `#merrychristmas` for a Chris) and anything else (`#jordanbae`), and so is a three-letter one run into a word of a tag (`#samstrong`, `#teamsam`, `#prayformia`: a "#samedrill" for a Sam costs one yes); in the speaker's words, a three-letter one is the name where camelCase starts and ends it ("#PrayForKai", "KaiStrong"), is asked about at the start or end of a tag's word, and is the word in an ordinary one ("same" for a Sam); Claude reads them as codes, and an ordinary word that holds one as written ("island" for an Isla: a person is asked about a line with it, Claude picks another);
- a shout-out names someone: a word right after "Thanks", "Thank you", "Love you", "Proud of you", "Birthday", "Coach", "Mr" and the like, or after "Go" where it ends the shout-out or another "Go" follows, is the name for anyone the graphic can't name ("Thank You Coach Will", "Happy Birthday Grace", "Go Hope Go", "Way To Go Hope"; "Go Chase Your Dreams" and "You Will Never Walk Alone" are asked about). A tag reads the same way (`#HappyBirthdayGrace`, `#GoHopeGo`; `#NeverLoseHope` is asked about), a tag typed all in lower case too where a name ends it right after a shout-out's own letters (`#happybirthdaygrace`, `#gohope`, `#thankscoachrivers`). After "Go" or "Hey", a first name is the name (`#GoGrace`, `#heygrace`, a second first name too: Grace for a Mary Grace Long), but a surname that's an everyday word (the card's last word: cards are written first name first, as the card form says) is a team chant as often, so it's asked about (`#GoGreen`, `#gowest`, `#heyday`, "Go Green Go White" for an Ava Green); and a line in Title Case also by its last word ("Keep the Faith" for a Faith): write it in sentence case if it isn't one. The name of an adult the graphic can't name, run into a word of a tag, is the name where it ends that word or starts it before a tag's usual last word (`#teamrivers`, `#riversstrong`), and asked about where it starts another word (`#riverside`) or sits inside one (`#coachriversrocks`). An everyday word that's also such a name, at the start of a sentence ("Will never quit"), is asked about; the writer's "not a name here" counts for that exact text. Mid-sentence with a capital ("we ran it with Will"), it's a name. The credit names a speaker only if they're an adult, cleared, and their release covers their name and lists the format. A closed film makes no graphics. Drafts stay in this session only, for a day at most. Until Kyron and Coach Hooks turn on *The graphics system*, every graphic carries a **PROPOSED** band and nothing goes to review; the screen reads the switch afresh before saving or sending. The fonts are in `public/app/fonts` (SIL Open Font License, `OFL.txt`) and cached with the app.

## Posting and takedowns

Only Kyron records posts, after the final sign-off, and only cuts every speaker in them approved, with everyone in them cleared.

**Consent pulled** (the producer, from the card): every card with that code is closed, every film they're in is pulled for good, live review links stop, and a takedown opens with a line for every live post plus one for everything outside the app (drives, the Milanote board, the editor's machine). **The 72-hour clock** starts at once and shows on Today. Marking a line down takes its post down; the last line closes the takedown.

The files of those films (uploads, review copies, posters) are listed for removal by the database in the same change, and removed at once; anything storage refuses is tried again on the worker's next pass (`studio_storage_removals`). A deleted cut's files go the same way, and so do any the worker made for a cut that didn't make it. For three hours after a pull, the worker also empties the pulled film's whole folder on every pass (every pulled film, newest pull first, a page at a time): an upload link made just before the pull (they last two hours) can still land a file no row lists. A file in that folder that storage won't remove goes on the removal list, so it's tried again after the three hours; a folder storage won't list is looked at again on the next pass. The same pass closes any takedown with nothing left on it, one at a time, leaving one that someone is changing right now for the next pass.

A takedown's lines lock the takedown as they're marked down, so the last line always closes it; the worker closes any takedown with nothing left on it, as a safety net.

## Real words and three directions

The film's room → **Real words** (`public/app/film-words.js`, API `routes/studio-words.js`, migration 041).

**Transcripts.** Export the interview's transcript from Resolve: subtitles (`.srt` or `.vtt`), or text with a timecode on each line. A timecode that counts frames needs the timeline's frame rate. The file is read on the phone (`public/app/transcript-parse.js`), and only the speaker's lines go to the server:
- In a file with speaker labels ("Coach:", "JOSÉ:", a voice tag, "Speaker 1", a name in brackets as SDH subtitles write it: "[COACH]", "(INTERVIEWER)"), you pick which label is the speaker. The interviewer's questions and everyone else's lines stay on the phone. A subtitle with two voices or two labels in it is split between them, its time shared by their words, and a line with no label before any label is a voice the file doesn't name: "(no label)" sends only those lines. A sound note in capitals isn't a name ("[APPLAUSE]", "(LAUGHS)", "[MUSIC PLAYING]"), and a label with a note after the name is the label ("INTERVIEWER (O.S.):", "COACH (V.O.):", "PAT (CONT'D):"). In a file with no labels, a name in brackets ("[REFEREE] Foul on number three.") is a voice nobody names: its words are nobody's.
- A subtitle with a dashed line in it ("- No.", "-No." or "- 500 a day.") or a ">>" line (a broadcast caption's new speaker, at a line's start or in the middle of one: "Every Sunday. >> Why Sunday?"; "> >" and "»" too) has two voices: its lines with no label or voice tag of their own are nobody's. So are the words after a voice in brackets, at a line's start or in the middle of one: someone named by who they are ("[man] Why that year?", "[crowd chanting] Let's go!", "[INTERVIEWER, OFF-SCREEN]"), a name in brackets in a file with no labels, and, after a sentence's end, a name or a label in capitals ("Every Sunday. [INTERVIEWER] Why?", "Every Sunday. INTERVIEWER: Why?", "(INTERVIEWER)"). So are lines all in italics (subtitles mark an off-screen voice that way, and sometimes the speaker's own voice-over) and sung lines ("♪ …"). A note isn't a voice, and the speaker's words go on: a sound ("[APPLAUSE] Thank you all.", "[whistle blows]"), how they say it ("[laughs nervously]", "(sighs)", "[SCOFFS]"), the language ("[in Spanish]"), the editor's own ("[bleep]", "[sic]", "[2019]", "He told [Coach Hooks]"); missing words ("[inaudible]") are a mark no line reaches across. They stay on the phone in any file, are never in "(no label)", and no kept line reaches across them. A file that marks speakers with ">>" and names none is nobody's throughout, and the screen says so: export it again with speaker names. A minus glued to a number ("-5 degrees") and an en or em dash carrying a line on ("—and then") aren't a second voice; a dialogue dash before a capital or "¿" is.
- A label is read at the start of a subtitle, a dashed line or a ">>" line, and on a later line only when it looks like one ("INTERVIEWER: Why?": capitals, "Speaker 2", or one to three capitalised words, not a day, a month or a word like "Listen"). Words before a colon on a wrapped line ("for all of us: show up", "Saturday: run it again") are words, and someone quoting someone ("He said: keep going") is never a label. In a file with labels, words before a colon that don't look like a label, at a subtitle's start or on a dashed line, are nobody's, and so is what follows them with no label until the next one, as after a two-voice subtitle.
- In a file without labels, every line goes as the speaker's words, so you confirm only their words are in it.
- You pick whose card the words belong to (nothing is picked for you), and give it a label with no name in it ("Interview 1"). Whoever added it, or the film's people, can rename it later (*Rename* on the transcript).
- A line that comes after someone else's (a question left out) is marked, and no kept line reaches back across it; unless the file names two voices or more, so is one after a pause of more than three seconds (a question cut out of the file leaves one, and a file whose only label is the speaker's may have had its questions cut). The marks show between the lines when you pick. "[inaudible]" and "[crosstalk]" stay in the words as ⟨…⟩, and no line reaches across that either.
- Timecodes read to the frame (rounded). A drop-frame transcript (";" before the frames, 29.97 or 59.94) is kept as one, and shows its timecodes as Resolve does. A transcript past ten hours is refused with a note on how to export it.
- A board link that names someone on the cards ("instagram.com/jamierivers") isn't shown to an agent: only that there was one.

Limits: 5,000 lines, 2,000 characters a line, 300,000 characters in all.

**Adults first.** Only a cleared adult speaker's words can be used: a speaker card, not a minor, cleared, consent standing, the release covering their voice. Anyone else's card says why not. When a card changes so their words can't be used (consent pulled, marked a minor, no longer a speaker, voice no longer covered), the database removes their transcripts and every line kept from them.

**Lines by hand.** The film's director, editor or producer opens a transcript (everyone else reads it), taps the line where the words start and the one where they end (12 at most), and trims the words to the line they want. They have to be the speaker's own, word for word, from a whole word to a whole word (not "4 forty" out of "4.4 forty", "30 every morning" out of "5:30", "I can" out of "I can´t", or a word joined to another by a dash): the server finds them in the transcript and works out when they're said. Words said twice in the lines picked have to be picked from the one cue. The database checks the quote again, whole words, gaps and all, and that its times fall inside its cues (it doesn't work the times out again). A line that names someone on the cards (a whole name, one run together, any word of a minor's name, or one run into a tag or a word: "#PrayForJamie") or has a banned word is refused; a line with one word of an adult's name ("Darnell taught me everything") is asked about, and kept once you say it isn't a name there. A caption opens on the speaker's line and runs under 60 words; that line and your words after it carry no promise of reach (views, followers, being noticed by recruiters, an offer) and no emoji chains (🔥🔥🔥, 🔥.🔥.🔥, flags), and your words carry no names (any word of one) and no line written for someone in quotes of any kind.

**When a card changes.** A card added or renamed whose name is in a kept line, a caption, a title or note of ours, or the directions waits, and the refusal says which: remove the line, or rename the transcript (the database holds this). A transcript's label is read as strictly as when it was added: any word of the card's name in it holds the card too. A card corrected to a minor never waits, since that's the safety step: their transcripts and lines go, and so does every kept line and every set of directions on the film that names them, a transcript's label that does is renamed to its own speaker's code, and their name in the film's title or story becomes the card's code wherever a word of it stands apart from other letters ("Ty", "Ty's", "Ty2", "Ty_23"; not "Tyler"). A pulled film's stay as they were, and if the title or the story still reads as naming someone on the cards after the swap (the parent set with the correction, an everyday word asked about while they were an adult), the screen says so: change it then. The correction itself never waits. Kept lines the app reads as their name run into a word ("#letsgojamie", "#bigjamieenergy") go with it too, and a minor's card waits for them as for any other kept line that names them. A minor's card also waits for a kept line with their name run into a tag ("#PrayForKai"). A release taken off file, like a release no longer covering the voice, takes the speaker's transcripts and their lines with it.

**Claude** reads the transcripts only once Kyron turns on *Claude reads transcripts*. The film's director, editor or producer asks, one run at a time for a film. Claude reads every transcript whose words can be used, with people as code and role and every name said in them as a code ("WJ01 gets up at five"). Before each page it reads and before it hands the set back, the switch, the film, and every transcript it has read and its speaker's card are checked again; so before the judge reads the set, and before a retry. The first "no" stops the run there: nothing more goes to the model (not even the tool's answer), no judge reads it, and nothing is kept. Two asks at once start one run. Claude can't be asked "is that a name here?", so a line or note of Claude's with any word of a card's name is refused. It hands back:
- up to 12 strongest lines;
- two or three structures (3 to 12 beats, the speaker's lines in order);
- up to 6 cutdowns whose first line lands in the first two seconds (up to 5 lines after it);
- up to 6 captions.

Every quote goes through the same checks as a line picked by hand. A new set replaces Claude's last one, and lines people kept stay. The run's record keeps no words: counts, and which tools ran.

**Three directions for a film.** The producer or the director asks. Three Directions reads the board (names as codes), the cards by code and role, the kit's cards and the taste library. It hands back three different ways to make the film, each with:
- a logline and 3 to 8 beats;
- the look and the sound;
- three must-have shots;
- why it fits, and the risks.

It writes no lines for anyone: a quoted run of three words or more, in quotes of any kind or after "says:", is refused, since only real words are used. Two directions that are nearly the same film are refused too. A taste note it cites is kept as its number, title, link and the use made of it. The producer picks one, and *Use its must-haves* puts its three shots on the board.

**The Brief Writer** hands back three directions too, each a whole brief, and says which it would pick and why. Whoever asked for it (or the producer) picks one, edits it, and starts the kit run with it; the run's task says which brief and direction it came from. Or you set the brief aside (your edits stay on the screen). **Today lists your briefs that came back and were neither started nor set aside** (the last 60 days). A started brief stays started, with its first run and direction: starting it again makes another run and leaves that as it was.

**The taste library** (Studio → *Taste library*, `public/app/taste.js`, API `routes/studio-taste.js`) keeps notes on work worth learning from:
- a link to the work, what it is, what to take and what to leave, and tags;
- never a picture or a copy of the work: a link to an image or video file (by its ending, in any case, behind ";v=2" or "%2E" too), to an image service's own address, or with format=jpg in it, is refused, by the app and by the database (a link that redirects to a picture can't be told);
- no name on any film's cards (a whole name, one run together, any word of a minor's), since every film reads it; agents read it with names as codes;
- a number for each note ("Taste 12"), which briefs and directions cite; Claude checks a cited note exists;
- search by words (any form) or by tag.

Whoever added a note, or the producer, edits or archives it. Archived notes are kept, never deleted, and searches skip them. A note written before a card with one of its words came along can always be archived (an edit that keeps the word can't be saved). Agents read every note with every card's name, on any film, as a code.

## The kit learns from the work

Migration 042, API `routes/studio-learn.js`, screens in `public/app/learn.js` and the kit page.

**Wrap-ups** (the room → *Wrap-ups*):
- What worked on the film, what missed, and what the kit should change, with the kit card it's about if you know it.
- No names. A wrap-up goes to the whole kit, so it's held to what a kit holds: a name of anyone on any film's cards is refused (a word of one, a minor's from two letters or run into a tag, the whole name, one run together), by the app, and by the database for whole names, names run together and minors' names. A word that's also a name (on this film's cards, or an everyday one that starts a sentence) is asked about first; a word that's surely a name can't be cleared that way.
- Whoever wrote one edits it; they or an approver can remove it, until it's folded into a refresh. After that it's kept as it was. While a refresh is running with it, it stays as that refresh read it.

**Suggest an edit** (a card on the kit page): what the card should say and why.
- It names a card in the approved kit, not one of its locked rule cards (a refresh can't change those), and carries no name: a kit never does. It's checked against every film's cards, by the app and by the database, the reason for a decline too. A name for certain is refused, and the app says which word it read as one; a word that may be a name (an everyday word that's a name too, with a capital at a sentence's start or an adult's mid-sentence: "Hope never quits", "Mark IV", "In April") is asked about, and kept once you say it isn't one here. The same rules as wrap-ups (below).
- It stays open until an approver folds it into a refresh or declines it, with a reason. Never deleted. The kit page shows how many are waiting on each card.

**Copy the whole column** (the kit page): every card in the column at once, in order, to paste onto the Milanote board.

**Rules in the making.** A review-note label used on three notes of a kit's films is proposed as a rule for that kit. An approver folds it into a refresh or declines it, with a reason. A declined one comes back after three more uses. Every decision is kept: declining it again adds a decision, it doesn't rewrite the first.

**Names in what every film shares.** Wrap-ups, suggested edits, rule labels, decline reasons and the month's brief are read against every card on every film (all of them, page by page), so the check tells a name from an ordinary word that holds one:
- A name for certain: a whole name, or one run together ("JamieRivers"), and a first and last name without the middle one ("Grace Long" for a Grace Ann Long); a word of a name that's no everyday word ("Jordan", "Dana"), and its plural or possessive written without the apostrophe ("Jordans mom called", "KAYLEES DRILL"; a three-letter name's only with a capital, "Tims mom", never "three times"); a whole name run into a tag ("#teamjordanreyes"); a minor's name run into a tag, a handle, a link or a file name beside the tag's own word, another word of their name, initials or English words ("#jordanstrong", "#teamjordan", "@jordan.hoops", "jordan_final_v2", "kayleeb_hoops", "#jordanfootball", "#ourjordanfam"), into an ordinary word beside a tag's word or English words ("Jordanstrong", "Jordanfootball season"), or where camelCase starts or ends it ("JordanStrong"); a minor's everyday-word first name beside a word that says so ("#hopestrong", "#teamhope"; "#summertime" is asked); and an everyday word that's a minor's name, with a capital mid-sentence ("Ask Hope before the drill"). Refused, with the word.
- Asked: an everyday word that's a name, with a capital at a sentence's start ("Hope never quits", anyone's) or an adult's mid-sentence ("Mark IV"); a month's or a day's name ("In April"); a minor's everyday-word surname beside a tag's word ("#gogreen", "#teamgreen" for a Green) and an everyday word made that way ("#lifelong" for a Long); any other minor's name inside a tag's word that English words don't account for ("#ourkayleexyz"); and an adult's name run into a tag ("#teamrivers").
- Not read: a name inside an English word ("Milanote" for a Mila, "state" for a Tate, "label" for an Abel, "#islandlife", "#Philadelphia"), a short name's plural that's an English word ("three times", "Times are hard"), and everyday words in lower case. The app reads English from SCOWL's word list (utils/data).

**The month's refresh.** Today shows approvers *This month's kit refresh* when there's something new for a kit and its refresh hasn't run this month (and isn't running).
- *Open the month's brief* lists the wrap-ups, suggested edits and rules in the making, each ticked, and builds the Kit Refresher's brief from them. Anything that names someone on a card added since is held back: a wrap-up with a link to edit it on its film, a suggested edit or a rule (which can't be edited) with *Decline…*.
- Untick what shouldn't go in; edit the brief if you like. Your edits stay until you build it again from the ticks. The ticks decide what the run is given; at Start, a ticked item whose line isn't in the brief as written is asked about, and so is an unticked one whose line still is (the run would read it, and it would stay open). Declining something takes its line out of an edited brief (or asks you to). The composed brief stays under 5,800 characters, leaving room for your edits (a kit run takes 6,000); what doesn't fit waits for next month.
- *Start the monthly refresh* starts a kit run like any other, and it makes a draft only: nothing changes until Kyron approves it. The brief can't name anyone on any card: what a person wrote into it is read (the kit's title, its columns' and cards' titles, the formats' names and the dates the app writes aren't, each as whole words), a name for certain is refused with the word, and a word that may be one is asked about first.
- The run is marked with what it was given, under the kit's lock: one at a time, and only what's still open and in no other running refresh (or nothing starts, with the reason). A second one in a month is started on purpose (*Start another refresh this month*).
- What it was given is folded in, each once, only when it saves a draft. A run that fails, goes quiet for 90 minutes, or finds nothing to change leaves it all open for the next one. Something that can't be folded by then (a name came on a card since) stays open, and the run says how many.
- Kyron discards the draft: what its refresh folded in is open again, as it was, for the next one (a rule gets a decision saying so), and that refresh no longer counts as the month's having run. A draft discarded while its refresh still runs folds nothing in. Only a discarded draft gives anything back: the database checks for it.
- The database reads wrap-ups, suggested edits and rule decisions for names too (a whole name, one run together, and a minor's name word that's no everyday word, plain plurals and possessives of five letters or more included); the everyday words, short names' plurals and names run into tags are the app's. An approved kit is never given back, even if its row is set to discarded.

**The gear re-check.** Today shows *Gear re-check due* a month after the last one that ran through (a draft, or nothing to change), or when there's never been one. *Re-check gear* goes through the Brief Writer as before, and the run it starts (on the Same Work kit only) is marked as the gear re-check.

## Tool approvals

The kit's rule: a tool touches footage only once the producer has checked its terms and added it, with a one-line reason. Three switches start **off**; only Kyron turns them on, and the reason is kept:

- **Review copies in storage**: needed for uploads and review links. Turning it off stops every live link.
- **Claude reads transcripts**: Claude reads the cleared adult speakers' transcripts for the real-words tools. Off, lines are picked by hand.
- **The graphics system**: once Kyron and Coach Hooks approve the type system.

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
| POST | `/films/:id/graphics/check` `{ texts, speaker_id, credit, format, names_ok }` → `{ ok, problems, asks, credit }` | members |
| POST | `/films/:id/delivery-checks` `{ file_name, format, ratio, duration_ms, width, height, bytes }` | members |
| POST | `/films/:id/slides/upload`, `/films/:id/slides` `{ format, ratio, version, file_name, people, slides, made_with }` | members |

Real words (`/api/studio-words`, members with Studio; "the film's people" are its director, editor and the producer):

| Method | Path | Who |
|---|---|---|
| GET | `/films/:id` (transcripts without their words, the lines kept, directions, runs), `/transcripts/:tid` (its lines), `/runs/:rid` | members |
| POST | `/films/:id/transcripts` `{ person_id, label, frames, fps, drop, labelled, voices, cues }` | members |
| PATCH | `/transcripts/:tid` `{ label }` | whoever added it, the film's people |
| DELETE | `/transcripts/:tid` | whoever added it, the producer |
| POST | `/films/:id/lines` `{ transcript_id, from_cue, to_cue, quote, note, kind, after, names_ok }` | the film's people |
| DELETE | `/words/:wid` | the film's people |
| POST | `/films/:id/ask-claude` | the film's people, with *Claude reads transcripts* on |
| POST | `/films/:id/directions` | the producer, the film's director |
| POST | `/directions/:did/pick` `{ n }` | producer |

The kit learns (`/api/studio-learn`):

| Method | Path | Who |
|---|---|---|
| GET/POST | `/films/:id/wraps` `{ worked, missed, change, card_title, names_ok }` | members |
| PATCH | `/wraps/:wid` | whoever wrote it, until it's folded |
| DELETE | `/wraps/:wid` | whoever wrote it or an approver, until it's folded |
| GET/POST | `/suggestions?slug=&status=`, `/suggestions` `{ slug, column, card_title, suggestion, why, names_ok }` | members |
| POST | `/suggestions/:id/decline` `{ note, names_ok }`, `/labels/decline` `{ slug, label, note, names_ok }` | approvers |
| GET | `/monthly/:slug` | approvers |
| GET | `/today` | members (the month's refresh: approvers only) |

A kit run takes `{ purpose: "monthly", sources: { wraps, suggestions, labels }, again }` (approvers) or `{ purpose: "gear" }` (the Same Work kit), as JSON from the app's own pages, from a person (not the automation key). It answers 409 `refresh_refused` with the reason when it can't start (running already, run this month without `again`, or something picked was decided, folded or taken meanwhile), 400 `brief_has_name` with the `words` read as names, and 400 `brief_may_have_name` with the `words` to ask about (send them back as `names_ok` with the same brief). A name check that refuses answers `{ error: "invalid", fields: ["…_has_name"], words }`; one that asks, `fields: ["…_may_have_name"]`. Discarding a draft answers `given_back: true` when its refresh's items are open again.

The taste library (`/api/studio-taste`): GET `?q=&tag=&limit=`, GET `/tags`, GET `/:id`, POST (members); PATCH `/:id` with `seen`, POST `/:id/archive` (whoever added it, the producer). Briefs: GET `/api/studio-agents/briefs/unstarted`; POST `/api/studio-agents/briefs/:id/set-aside` `{ aside }`; a kit run started from a brief sends `{ from_brief, direction }`.

The speakers' page: `POST /api/studio-review/view {token}` and `POST /api/studio-review/decide {token, decision, name, note, confirm}` (POST and JSON only, from the site's own pages, 30 tries per visitor per 10 minutes).

## Setup

1. Apply `db/migrations/039_studio_films.sql` (tables, rules, the bucket `studio-films`), then `040_studio_craft.sql` (notes, delivery checks, stills and slides), then `041_studio_words.sql` (transcripts, lines, directions, the taste library, brief marks), then `042_studio_learn.sql` (wrap-ups, suggested edits, rule decisions, refresh marks and what each was given). None has been applied anywhere yet: each goes on fresh, in order (040 isn't written to upgrade an earlier draft of itself).
2. Optional settings on Render: `STUDIO_SITE_BASE` (default `https://www.tojcampaign.com`), `STUDIO_REVIEW_REPLY_TO`, `STUDIO_REVIEW_MAX_MB` (raise it after the Supabase Pro upgrade), `STUDIO_REVIEW_WORKER=off` to stop the worker on a server.
3. Kyron turns on *Review copies in storage* (Studio → Films → Tool approvals) once he's checked Supabase's terms, and *Claude reads transcripts* once he's checked Anthropic's terms for interview transcripts.
4. Email works as for the rest of the app (`EMAIL_USER`/`EMAIL_PASS` or `SMTP_*`); without it, review links aren't made.

## Known limits

- The kit names only some file codes (YTH, HERO in its example). The other lane and format codes (`NFL`, `COL`, `PAR`, `CUT`, …) are the app's until the kit names them; the file-name check only warns.
- Coach Hooks's yes is recorded by the producer with how it came (a text, an email), not by Hooks in the app.
- The worker reads a review copy into memory to upload it (a 10-minute copy at 720p is tens of megabytes).
- The speakers' page limits tries per visitor by `X-Forwarded-For`, which a caller reaching Render directly can set. The per-connection limit and the 256-bit tokens still hold.
- If the phone closes the app with no signal, the app opens at sign-in until there's a signal again: open shoot mode before the signal goes.
- The end card is a type stand-in until the Coached by Hooks mark file is added to the app.
- The graphics read the speaker's line as typed: copy a kept line from Real words into the graphic.
- A line is checked against the transcript, not the sound: a word Resolve misheard is kept as Resolve wrote it. Fix it in Resolve and add the transcript again.
- A line's start and end inside one transcript line are estimated from where its words fall in that line, so they can be off by a fraction of a second; a cutdown's two seconds are measured the same way.
- A minor's words can't be used at all yet (adults first): their review comes later.
- The month's refresh is started by an approver from Today, not on a timer: nothing runs a model on its own. The automation key can't start it or the gear re-check.
- Declining a suggested edit or a rule while a refresh is running with it waits until that run ends.
- A wrap-up's card is free text (with the kit's titles offered); a title that isn't a card's is kept as written.
- A word that's a name on any card and something else too (a town, a school, a camera: "Austin", "Madison", "Alexa") is refused in what every film shares once someone with that name is on a card, as a name would be: the app says which word, so it can be written another way. A minor's name is never kept on a writer's say-so.
- The phone's copy of the shoot sheet drops lines that read like a name or a place by their capitals, the cards and *Locations*; a name typed all in lower case, of someone not on the cards, can't be told from other words. Keep names on the cards and places under *Locations*. A line may start with a capital only on an ordinary word (the app's list: family, gear, the field and the shot) or one the kit itself uses; a place's ordinary words ("practice field", "high school", "park") don't keep a line off the phone, its own name ("Westlake") does; a place named only with ordinary words keeps them when they're typed with its capitals, two or more in a row ("Park High School", "Home Field"), or in sentence case ("Park high school gym", "Home field"), while ordinary words typed in lower case after a place's name describe ("practice field behind the gym", "by the track") and one alone isn't a name ("Home"); each part of a location is a place of its own ("The Rowe house on High Street", "Home Field, Riverside"). A location typed all in lower case keeps every word of a part with no name of its own off the phone: type a place's name with its capitals.
- A minor's name run together ("tyng") is caught by the app from four letters; the database's own screen starts at five.
- The still check reads a slide's pixels in the web server's own process: about a tenth of a second for the largest it takes (3000 × 2000), a few hundredths for the kit's sizes.
