# Tool Research — picking what to recommend

How the Opportunity Mapper and Report Architect choose tools. The goal is a short list of tools the client can actually run, each pointed at a named pain.

## Two kinds of solution

### Basic SaaS (most clients)
Off-the-shelf products the owner sets up once and runs. This covers the large majority of small-business pain:
- **Automation glue:** Zapier, Make (make.com), n8n (n8n.io) — connect the apps they already use, automate 1-3 step repetitive tasks.
- **Off-the-shelf AI:** transcription, scheduling, inbox triage, content drafting, a CRM with built-in automation.
Match complexity to the operator. If the owner has no technical help, recommend the tool with the shallowest setup, not the most powerful one.

### Custom Claude skills / GPTs (custom businesses)
When the workflow is specific to that business and no off-the-shelf tool fits, the answer is a **custom GPT or Claude project trained on their content library** — their docs, their listings, their brand voice, their SOPs. This is the higher-value, higher-effort work (the Knowledge Systems tier). Example: an entrepreneur who lists businesses for sale got 400-500 emails per listing asking the same five questions. The fix wasn't a SaaS tool — it was a custom GPT trained on each listing's marketing, handed to buyers via a link instead of his inbox.

## The research step is a human verification layer

Live web research is NOT a wired tool in this agent stack. When an agent names a tool, it reasons from model knowledge and then hands the operator a verification step. Two directories to verify current tools, pricing, and fit:
- **futurepedia.io**
- **theresanaiforthat.com**

**Never invent a price.** Give a plausible range and mark it `[VERIFY]`. The operator confirms live before the report goes to the client.

## Selection heuristics

1. **Point every tool at a pain.** No tool earns a slot without a named pain from the transcript.
2. **Prefer the boring, proven tool** over the shiny new one when the client has to run it themselves.
3. **Watch compounding.** A 30-minute manual task automated today becomes a 2-hour/week drain a year out as the business grows — automate the thing whose cost grows with them.
4. **Fewer, stronger.** 3-7 recommendations. Five strong beats seven soft.
5. **Sequence by effort.** Lead the report with the low-effort / high-impact quick win; park the high-effort builds under "what comes after."

## Cross-skill

- `roi-levers` — the gate every tool passes.
- `report-blueprint` — where tools land in the deliverable.
- `offer-ladder` — custom builds map to specific implementation tiers.
