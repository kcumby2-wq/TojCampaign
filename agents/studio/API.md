# Studio Agents — Milanote kits

The studio pack turns production playbooks into **Milanote kits**: one board written out as columns of cards, with a page where every card has a copy button. It is the Same Work Milanote kit (built by hand on Oct 19, 2026) made repeatable:

- **Kit Refresher** (`kit-refresher`) starts from the approved kit and makes the smallest set of changes a brief asks for: re-check Netflix's camera list and the other gear, update a source, add a card, fold in a playbook revision.
- **Kit Builder** (`kit-builder`) builds a new kit from a playbook (pasted, or a PDF read in the browser) and a brief.
- **Brief Writer** (`brief-writer`, pack `agents/studio-brief`) turns an idea plus references (photos, video stills, links, PDF or text) into the brief for either of them. It reads the approved kits and the links, and changes nothing. "Use this brief" puts it in the run form.

In the TOJ app: tojcampaign.com/app → Studio. The older console is `/admin/studio-agents.html`.

## The safety model

1. **The approved kit is never edited.** A run stages its work in memory and saves a **new draft version** when it finishes. Nothing an agent does touches an existing version.
2. **A person approves.** `POST /kits/:id/approve` needs an approver or the owner, signed in (an API key can't approve). Approving retires the previous approved version to `superseded` in one transaction (`studio_kit_approve`, migration 018).
3. **The first Same Work kit ships in the repo**, read-only: `kits/same-work.v1.json` (id `builtin:same-work:v1`). Until a newer version is approved, it is the approved Same Work kit.
4. **Locked rule cards** (who owns what, the seven rules, minors on set, tools not approved for footage, what the editor never does, the honesty rule for vintage looks) can't be changed by a refresh unless the person starting it ticks *Allow rule changes*. An API key can't set that.
5. **Checked twice.** Every write is checked as it's made (`kit.js` `checkCard`): banned words, HTML a Milanote paste can't take, https-only links, known template images. The judge (`evals/studio-principles.js`) then scores the staged kit itself (not just the agent's closing text) and auto-fails on any kit-check blocker, banned word, invented quote, identified minor, banned tool presented as allowed, or a claim to have published. A run that fails after 3 attempts still saves its draft, marked *failed the judge*, so Kyron can see what went wrong; approval also refuses a draft with blockers.
6. **The page is for the team only** (viewer or above). Template images (placeholders and silhouettes, no real people) load from signed URLs so a dragged image still reaches Milanote.

`tests/studio-kit.test.js` renders the approved kit and checks the page is **byte-identical** to the page published on Oct 19, 2026 (sha256 `b49734…37e8`).

## Endpoints

All under `/api/studio-agents`. Auth is by team role (utils/team.js, the TOJ app's Team tab): viewers open kits; members write briefs and start runs; approvers and the owner approve and discard; only the owner allows rule changes. `X-Studio-API-Key: $STUDIO_API_KEY` acts as a member (it can start runs, never approve).

| Method | Path | Auth | What it does |
|---|---|---|---|
| GET | `/roles`, `/skills` | none | Metadata |
| GET | `/kits` | team or key | Every version: built-in and saved (no kit bodies) |
| GET | `/kits/:id` | team or key | One version: the kit, its check, its diff against the version it started from, the change log and the agent's summary |
| GET | `/kits/:id/page` | team or key | The Milanote kit page, with a status bar (Approved / Draft / Superseded) |
| POST | `/kits/:id/approve` | **approver or owner** | Approve a draft (refused while it has blockers, or if a newer version was approved since) |
| POST | `/kits/:id/discard` | **approver or owner** | Discard a draft |
| GET | `/assets/:set/:file` | signed URL or team | A template image |
| POST | `/run` | member or key | Start a run → `{ run_id }` |
| POST | `/brief` | member or key | Start the Brief Writer → `{ run_id, references }` |
| GET | `/runs` | team or key | Recent studio runs (for the app's Today) |
| GET | `/runs/:id` | team or key | Poll: `running` → `completed` / `waiting` / `failed`, plus the draft it saved |

### POST /run

```json
{
  "role": "kit-refresher",
  "slug": "same-work",
  "brief": "Re-check the Gear and Edit suite columns against current sources...",
  "source_text": "(optional for a refresh; required for a build)",
  "allow_rule_changes": false
}
```

```json
{
  "role": "kit-builder",
  "slug": "pylon-signature-series",
  "brief": "Rebuild this playbook as a Milanote kit the way Same Work was built...",
  "source_text": "(the playbook text, at least 200 characters)",
  "assets": "same-work"
}
```

- `slug`: lower-case letters, numbers, dashes. A build refuses a slug that already exists (409 `slug_exists`): refresh it instead.
- `brief`: up to 6,000 characters. `source_text`: up to 300,000.
- `assets`: a template image set (`same-work`) or omitted for none.

Runs take roughly 5 to 20 minutes (Opus with web search and fetch, up to 3 judged attempts). Poll every few seconds.

### POST /brief

```json
{
  "idea": "I like the grain on these, can we get that look for Same Work?",
  "target": { "mode": "refresh", "slug": "same-work" },
  "links": [{ "url": "https://www.youtube.com/watch?v=...", "caption": "the grain at 0:40" }],
  "images": [
    { "media_type": "image/jpeg", "data": "<base64>", "caption": "this grain" },
    { "media_type": "image/jpeg", "data": "<base64>", "caption": "dusk", "video": { "group": 1, "at": 12.5, "duration": 42 } }
  ],
  "files": [{ "caption": "notes", "text": "..." }]
}
```

- `target.mode`: `refresh` (with `slug`), `build`, or `either` (the Brief Writer decides).
- Photos: JPEG, PNG, WebP or GIF, up to 12. Video: up to 4 videos as up to 8 stills each (the page takes 6, in the browser). All pictures together stay under about 3.3 MB. Links: up to 10. Files: up to 3, 60,000 characters each.
- **Pictures are sent to the model for this run only and never stored.** File names never leave the browser; references are called Image 1, Video 1, Link 1, File 1. The stored task keeps the idea, the notes, the links and file text.
- Poll `GET /runs/:id`; when done it carries `brief`: `{ mode, slug, title, brief, needs_source, references: [{ ref, what_it_shows, take, leave, seen }], questions }`.

### Example: a monthly refresh from a scheduler

```bash
curl -s -X POST https://www.tojcampaign.com/api/studio-agents/run \
  -H "Content-Type: application/json" -H "X-Studio-API-Key: $STUDIO_API_KEY" \
  -d '{"role":"kit-refresher","slug":"same-work","brief":"Monthly re-check: Netflix approved cameras, camera specs, transcription and caption tools, reference follower counts. Change only what moved; update dates and the Sources card."}'
```

The result is a draft waiting for approval. Nothing reaches the crew until Kyron approves it.

## Files

| Path | What it is |
|---|---|
| `kit.js` | Kit shape, checks (`checkCard`, `checkKit`), diff, text views for the judge |
| `kit-render.js` | The kit page (port of the Oct 19 page; parity-tested) |
| `tools.js` | Per-run tools that stage writes; `web_search` and `web_fetch` server tools; the judge's view |
| `service.js` | Storage (`studio_kits`), versioning, signed image URLs, the run task |
| `roles/` | `kit-builder.js`, `kit-refresher.js` |
| `skills/` | `milanote-kit.md` (the method), `production-guardrails.md` (the lines), `reference-library.md` (Same Work's approved references, gear and sources) |
| `evals/studio-principles.js` | The judge |
| `kits/same-work.v1.json` | The approved Same Work kit, Oct 19, 2026 |
| `assets/same-work/` | The eight template images and `templates.json` |

## Setup

1. Apply `db/migrations/018_studio_kits.sql` and `019_team.sql` to Supabase (both applied Oct 19, 2026).
2. The server needs `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_EMAILS` and `SESSION_SECRET` (already used by the other packs). Optional: `STUDIO_API_KEY` for scheduled refreshes; `STUDIO_ASSET_SECRET` to sign image URLs with their own secret.
3. Web search and web fetch must be enabled for the Anthropic organization behind `ANTHROPIC_API_KEY` (an organization admin setting in the Claude Console). If they're off, runs still work from the approved kit and the reference library, but nothing gets re-checked.

## What still needs a person

- **New template images.** The agent can only use the templates in `assets/<set>/`. For anything new it writes a note card describing the image for a designer.
- **Pages behind a login.** Instagram often blocks fetching. The agent keeps the approved card and marks it not re-checked.
- **Approval.** Always.
