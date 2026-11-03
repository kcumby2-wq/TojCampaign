# Team chat in the TOJ app

Rooms for each Pylon stop and region, rooms the team makes, and direct messages. It's the Chat tab in the TOJ app. It's for the team only: owners and the people Kyron invites. Athletes, families and creators aren't in it.

Code:

- `routes/chat.js`: the API at `/api/chat`.
- `utils/chat.js`: the rules.
- `public/app/chat.js`: the screens.
- `db/migrations/026_team_chat.sql`: the tables, with the text rule and the room shapes checked again in Postgres.

## Who's in it

- Everyone on the team can use chat. That means owners on `ADMIN_EMAILS` and active team members, in any role.
- Each person joins once. They confirm they're 18 or older and pick the name people see.
  - Nobody joins without the confirmation, and the database won't store a person without it.
  - An address on the crew list as a youth creator can't join, whatever the form says. If the crew list can't be read, nobody new joins until it can.
  - Names are unique whatever the case, so nobody can post as someone else. Messages from owners and approvers carry their role.
- Team emails never leave the server. People appear by the name they chose and their role:
  - Owner
  - Approver
  - Regional Director
  - Member
  - Viewer

## Rooms

| Room | Who can read it | Made |
| --- | --- | --- |
| **Team** | Everyone on the team | The first time anyone opens chat (migration 031) |
| **All of Pylon** | Everyone with Pylon events | The first time someone with Pylon events opens chat |
| **A region** (West, South Central, Northeast, Southeast, Midwest) | Everyone with Pylon events in that region. Owners and approvers read every region. | The same way |
| **A stop** | Everyone who can see that Pylon event: owners, approvers and the region's directors and viewers | The first time someone opens **Stop chat** on the event plan. It appears in the Chat list once someone writes in it. |
| **A room someone made** | Only the people listed | Owners and approvers make them and add or remove people. Anyone added can leave. |
| **A Studio kit** | Everyone with Studio. One room per kit, across its versions, built-in kits included. | The first time someone opens **Conversation** on the kit (031) |
| **A booking** | Owners only, like the booking itself | The first time an owner opens **Conversation** on the booking (031) |
| **An operating system build** | Everyone with Operating Systems. An Authority build is owners only, as in the Operating Systems tool, because it can hold minors' details; its room says so. Chat never loads a build's intake, only its saved name. | The first time someone opens **Conversation** on the build (031) |
| **A direct message** | The two people in it, and nobody else (the owner included) | **Off** unless the server has `CHAT_DMS=on` (Kyron chose rooms and work conversations without DMs, Nov 3). With it off, nobody can start one and any from before stay hidden. |

- **Roles and regions decide rooms on every request.** Change someone's regions, and their region and stop rooms change with them.
- **Taking someone off the team** takes them out of every room they were added to. If they're invited back, they aren't handed what was said while they were gone. Chat can't hold up a removal: if that step fails, they leave those rooms when they join again.
- **A room you can't read answers "not found",** as if it weren't there.
- **A DM closes when the other person leaves the team.** You can still read it, but you can't send in it.

## What can go in a message

- **Text only.** No photos, video or files. Media stays in the event's tools, where consent is checked.
- **No email addresses or phone numbers.** The app refuses them, and so does the database, on a normalized copy of the text:
  - full-width digits and @ count, and so do non-breaking spaces and every kind of dash;
  - hidden characters don't hide anything;
  - a phone-length number in a `tel:`, `sms:` or `wa.me` link counts, written as a link writes it, so "FaceTime: 3pm" and "SMS: 2 bounced" are fine;
  - a long number elsewhere in a link doesn't (a URL's ID isn't a phone number).

  Chat is the contact channel for the team, and families' details stay in the event's tools.
- **Up to 2,000 characters.** At most one blank line in a row. Invisible and text-direction characters are removed.
- **Athletes by team and jersey number only.** Every room shows this rule at the top. Chat can't check it, so it's on the people writing:
  - no names, contact details or film links;
  - no permission flags or takedown reasons. Those stay in the event's tools, where viewers can't see them.
- **20 messages a minute per person.**

## Edits, removals and deleted accounts

- You can edit or remove your own messages.
- The owner can remove anyone's message. Each removal of someone else's message goes in the team activity feed ("removed a message in chat"), with no text.
- A removed message keeps its place and loses its text.
- Deleting your account from the Team screen removes the text of every message you wrote, then your chat record. Others see "Former teammate."

## Unread and notifications

- **Unread counts.** The Chat tab shows a count of unread messages, outside muted rooms, checked every 45 seconds. Opening a room marks it read.
- **An open room** checks for new messages every 4 seconds while it's on screen. Every 30 seconds it also picks up edits and removals.
  - It asks for everything after the last message the server sent it. Your own sends don't count, so a message someone posts just before yours is never skipped.
  - Sending doesn't mark anything read. The room's next check does, for what it fetched.
- **Who gets a notification.** A new message notifies everyone who can read the room, except:
  - the sender;
  - anyone who had the room open in the last 20 seconds;
  - anyone who muted it. Muted people still hear about an @mention of their name.
- **What a notification says.** It carries the room's name and the sender's chat name, such as "Wes sent a message" or "Wes mentioned you". A booking's room is "A booking" and a build's is "An operating system build", never the family's event or the client's name. It never carries the message, so what people write in chat doesn't pass through Apple's or Google's push services. Room names never name an athlete, since they show in notifications.
- **Mentions.** Type @ and the start of a name to mention someone in the room.

## Setting it up

1. **Apply migration 026 in Supabase, with Kyron's OK, after 024.** A stop's room points at its event. It only adds: five `chat_*` tables, with the functions and triggers that check them.
   - Everything is service-role only: RLS is on with one service-role policy per table, and the API roles can't call the two functions the server uses.
   - Until it runs, the Chat tab says chat isn't set up yet. The Team screen still opens from it and from your initials on Today, and deleting an account still works.
2. **Apply migration 031 in Supabase, with Kyron's OK, after 026 and 030 (both already in production).** It adds the Team, kit, booking and build rooms to `chat_rooms` (three columns and their checks) and the `team_tools` table for the tool shelf. Until it runs, chat works without them: there's no Team room, a work conversation says chat isn't set up yet, and the tool shelf is empty.
3. **Merge, then let Vercel and Render deploy main.** Nothing to set on the server. `CHAT_DMS=on` on Render turns direct messages on, if that's ever wanted.

## API

All routes need a signed-in team member. Every route but `/me` needs them to have joined chat.

| Route | What it does |
| --- | --- |
| `GET /api/chat/me` | Your chat name, or `null` before you join |
| `POST /api/chat/me` | Join (`{ name, adult: true }`) or change your name |
| `GET /api/chat` | Your rooms and DMs, with unread counts and the latest message |
| `GET /api/chat/unread` | The unread total, for the tab |
| `GET /api/chat/people` | People you can message |
| `POST /api/chat/dm` | Open a DM: `{ person }` (only with `CHAT_DMS=on`) |
| `GET /api/chat/stop/:eventId` | A Pylon stop's room |
| `GET /api/chat/kit/:slug` | A Studio kit's room |
| `GET /api/chat/booking/:id` | A booking's room (owners) |
| `GET /api/chat/os/:id` | An operating system build's room |
| `POST /api/chat/rooms` | Make a room (owner, approvers): `{ title, people }` |
| `GET /api/chat/rooms/:id` | A room: who can read it, its rule, what you can do |
| `PATCH /api/chat/rooms/:id` | Rename it, or add or remove people (owner, approvers) |
| `PATCH /api/chat/rooms/:id/me` | Mute or unmute (`{ muted }`), or leave a room you were added to (`{ leave: true }`) |
| `GET /api/chat/rooms/:id/messages` | Messages: `?after=<id>` for newer, `?before=<id>` for older, `&read=1` to mark it read |
| `POST /api/chat/rooms/:id/messages` | Send: `{ body }` |
| `PATCH /api/chat/messages/:id` | Edit your message |
| `DELETE /api/chat/messages/:id` | Remove your message (the owner can remove any) |

## The tool shelf

Under Tools. The owner adds a name, an `https://` link, a short note and who sees it: everyone on the team, people with one tool, or owners only. Links open in a new tab; nothing on the shelf runs inside the app. Taking a tool off the shelf hides it, and it can go back later. The activity feed says a tool was added without naming it (who sees a tool can change later), and only to the people it was for. Code: `routes/team-tools.js`, `utils/tools.js`, `public/app/shelf.js`; the table is in migration 031.

| Route | What it does |
| --- | --- |
| `GET /api/team-tools` | The tools you can open (the owner also gets the ones off the shelf) |
| `POST /api/team-tools` | Add one (owner): `{ name, url, about?, audience? }` |
| `PATCH /api/team-tools/:id` | Change it, or `{ archived: true }` to take it off the shelf (owner) |

## Open questions

1. **How long messages are kept.** Today they're kept until someone removes them or deletes their account. Should messages older than a year be purged?
2. **Links.** Links are allowed, because work needs docs, folders and designs, and the room rule asks for no film links. Should links be limited to a list of sites instead?
3. **Others in chat.** Creators on a crew, partners, or parents asking for help could be added later. Each needs its own sign-in, and parents would need an inbox rather than rooms. No athlete is ever in chat.
