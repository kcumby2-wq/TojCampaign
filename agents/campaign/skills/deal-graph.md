# Skill: the deal graph

A campaign's deal graph is the one record of its terms. Documents are compiled from it or checked against it; they never outrank it.

## Facts

Each fact has a **key**, a **kind**, a **value**, a **status** and a **source**.

- **Key**: lower-case, dot-separated, most general first. `split.pylon.event_sales`, `price.camp.standard`, `fee.optimum.lead_seat`, `milestone.signature`, `party.pylon`.
- **Kind** and the value shape it takes:

| kind | value shape (JSON) |
|---|---|
| party | `{"name": "...", "entity": "...", "role": "partner"}` |
| role | `{"party": "party.pylon", "does": "..."}` |
| offering | `{"name": "...", "unit": "per athlete"}` |
| price | `{"usd": 349, "per": "athlete", "options": [...]}` |
| split | `{"payer": "gfs", "payee": "pylon", "basis": "net_sale_price", "rate": 0.2, "order": "off_the_top"}` |
| fee | `{"usd": 3000, "per": "month", "payer": "...", "payee": "..."}` |
| obligation | `{"party": "party.toj", "does": "...", "by": "2026-11-14"}` |
| milestone | `{"date": "2026-11-14", "what": "..."}` |
| constraint | `{"rule": "..."}` |
| assumption | `{"value": 0.7, "note": "hypothetical license share"}` |
| disclosure | `{"audience": ["family"], "text": "..."}` |

- **Status**: `proposed`, `agreed`, `signed`, `posted`, `hypothetical`, `measured`. Agents only ever propose `proposed` or `hypothetical`; a person moves a term to agreed or signed.

## Versions

The graph changes only through numbered versions. At most one version is open (proposed, not yet approved). An owner or approver approves it; approval is final, and a later version supersedes it. A version can't be approved while a **blocker** finding on it is open.

`graph_read` with no version gives the latest approved graph. `graph_diff(from, to)` lists what was added, removed or changed.

## Claims and findings

A **claim** is what a document says about a term: a locator, the exact quote, the fact keys, and the value the words assert. A **finding** is a disagreement a person must fix or waive. Agents raise findings; only people resolve them.

## What never goes in the graph

No athlete or family records. No minor's name. Contacts are partner staff only.
