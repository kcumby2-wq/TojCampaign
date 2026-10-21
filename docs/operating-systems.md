# Operating Systems: building a client's OS in the TOJ app

**Where:** TOJ app → Tools → **Operating Systems**. The owner has it. A teammate gets it when Kyron ticks **Operating Systems** on their invite.

## The trail

The steps follow the site and its launch video, in the same order.

| # | Step | What happens | Who |
|---|---|---|---|
| 1 | Raw operation | Pick the door: Personal Brand, Non-profit or Authority. | Member |
| 2 | Foundation Score | Bring in the intake from the site's form, or answer the short intake in the app (three answers moves it on). The transcript is due 72 business hours after the intake (shown as a 3-business-day due date). | Member |
| 3 | The Standard | Claude drafts five-pillar scores (0–100, with one line of evidence and one gap each), or someone scores by hand. No pillar scores above 40 without evidence. | Member drafts or edits; **approver approves** |
| 4 | Operational Transcript | Claude drafts the seven sections from the approved scores, using the lane's section names. Banned words block approval. When approved, it goes into the client's portal (it needs the client's email). | Member drafts or edits; **approver approves** |
| 5 | Systemized | Start the install. The Intake, Delivery and Follow-up systems are listed per lane. Mark each one To do, Building or Live, and add your own. Generate the **operating brain**: CLAUDE.md, a daily workflow, a skill per system, the voice, config, the feedback loop and the transcript. Download it as a .zip. | Member |
| 6 | Trail of Joy | When every system is live and the brain exists, an approver hands it off. The brain is regenerated so it records the hand-off. | **Approver** |

Scores lock once the install starts. The intake locks once the scores are approved. Approving new scores after the transcript is approved sends the transcript back to draft, and the app asks you to confirm first.

## Roles

| Role | Can |
|---|---|
| Viewer | See builds, read transcripts and the brain |
| Member | Start builds, use site intakes, answer the intake, run or edit the drafts, install systems, generate and download the brain. Members see the client's email. |
| Approver | Everything a member can, plus approve scores and transcripts, and hand off |
| Owner | Everything, and the only one who sees **Authority** builds |

**Authority builds stay owner-only** because the Authority intake can hold minors' data, the same rule as the Intake CRM. Notifications about them go only to the owner.

## Setup

- **Migration 022** (`db/migrations/022_operating_systems.sql`) adds the `os_builds` table. It's service-role only.
- **`ANTHROPIC_API_KEY`** on Render turns on "Draft with Claude". Without it, the app scores and writes by hand.
- **`OS_MODEL`** is optional. It defaults to the model the other TOJ agents use (`agents/orchestrator-factory.js`).

## What the client sees

Approving the transcript, when the build has the client's email, does three things:

- It writes the pillar scores and the transcript link onto their Foundation Score.
- It adds a transcript deliverable.
- The client portal (`client.html`) then shows it.

The link, `/api/os/client/<id>/transcript`, opens only for:

- that client's portal account (a "client" login with the same email), or
- a teammate with the tool.

A self-registered account using the client's email can't open it.

## Privacy

- **What the model never sees:** contact details (email, phone, EIN) and the Authority intake's "named athletes" answer.
- **What the brain and the transcript never contain:** contact details.
- **Logs and the activity feed** carry ids and business names, never contact details. Authority builds show only as "an Authority operating system".

## Tests

`tests/os.test.js` walks the whole trail with a stand-in for Claude. It also covers the access rules, the evidence cap, the banned-word block, publishing to the portal, who can read the client's transcript, the brain's contents and the zip, Authority privacy, and scoring by hand without an API key.
