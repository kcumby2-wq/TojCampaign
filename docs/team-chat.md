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
| **All of Pylon** | Everyone with Pylon events | The first time someone with Pylon events opens chat |
| **A region** (West, South Central, Northeast, Southeast, Midwest) | Everyone with Pylon events in that region. Owners and approvers read every region. | The same way |
| **A stop** | Everyone who can see that Pylon event: owners, approvers and the region's directors and viewers | The first time someone opens **Stop chat** on the event plan. It appears in the Chat list once someone writes in it. |
| **A room someone made** | Only the people listed | Owners and approvers make them and add or remove people. Anyone added can leave. |
| **A direct message** | The two people in it, and nobody else (the owner included) | Anyone on the team, with anyone else on the team who has joined chat |

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
- **What a notification says.** It carries the room's name and the sender's chat name, such as "Wes sent a message" or "Wes mentioned you". It never carries the message, so what people write in chat doesn't pass through Apple's or Google's push services. Room names never name an athlete, since they show in notifications.
- **Mentions.** Type @ and the start of a name to mention someone in the room.

## Setting it up

1. **Apply migration 026 in Supabase, with Kyron's OK, after 024.** A stop's room points at its event. It only adds: five `chat_*` tables, with the functions and triggers that check them.
   - Everything is service-role only: RLS is on with one service-role policy per table, and the API roles can't call the two functions the server uses.
   - Until it runs, the Chat tab says chat isn't set up yet. The Team screen still opens from it and from your initials on Today, and deleting an account still works.
2. **Merge, then let Vercel and Render deploy main.** Nothing to set on the server.

## API

All routes need a signed-in team member. Every route but `/me` needs them to have joined chat.

| Route | What it does |
| --- | --- |
| `GET /api/chat/me` | Your chat name, or `null` before you join |
| `POST /api/chat/me` | Join (`{ name, adult: true }`) or change your name |
| `GET /api/chat` | Your rooms and DMs, with unread counts and the latest message |
| `GET /api/chat/unread` | The unread total, for the tab |
| `GET /api/chat/people` | People you can message |
| `POST /api/chat/dm` | Open a DM: `{ person }` |
| `GET /api/chat/stop/:eventId` | A Pylon stop's room |
| `POST /api/chat/rooms` | Make a room (owner, approvers): `{ title, people }` |
| `GET /api/chat/rooms/:id` | A room: who can read it, its rule, what you can do |
| `PATCH /api/chat/rooms/:id` | Rename it, or add or remove people (owner, approvers) |
| `PATCH /api/chat/rooms/:id/me` | Mute or unmute (`{ muted }`), or leave a room you were added to (`{ leave: true }`) |
| `GET /api/chat/rooms/:id/messages` | Messages: `?after=<id>` for newer, `?before=<id>` for older, `&read=1` to mark it read |
| `POST /api/chat/rooms/:id/messages` | Send: `{ body }` |
| `PATCH /api/chat/messages/:id` | Edit your message |
| `DELETE /api/chat/messages/:id` | Remove your message (the owner can remove any) |

## Open questions

1. **How long messages are kept.** Today they're kept until someone removes them or deletes their account. Should messages older than a year be purged?
2. **Links.** Links are allowed, because work needs docs, folders and designs, and the room rule asks for no film links. Should links be limited to a list of sites instead?
3. **Others in chat.** Creators on a crew, partners, or parents asking for help could be added later. Each needs its own sign-in, and parents would need an inbox rather than rooms. No athlete is ever in chat.
