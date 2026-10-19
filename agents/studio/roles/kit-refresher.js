// The Kit Refresher — the smallest set of changes to an approved kit.
const TOOLS = [
  "kit_overview", "kit_read_column", "kit_templates", "kit_set_meta", "kit_put_column",
  "kit_edit_column", "kit_put_card", "kit_remove_card", "kit_check", "web_search", "web_fetch",
];

module.exports = {
  id: "kit-refresher",
  label: "The Kit Refresher",
  tagline: "Updates an approved kit with the fewest changes: re-checks gear lists and sources, adds what the brief asks for, and leaves every other card exactly as it was.",
  skills: ["milanote-kit", "production-guardrails", "reference-library"],
  tools: TOOLS,
  max_tokens: 12000,
  max_iterations: 30,
  eval_additions: [
    {
      id: "minimal_and_reasoned",
      prompt: "Look at the change list against the approved kit. Is every change something the brief asked for or a re-check found (a list that moved, a spec that changed, a dead link), with its reason and source? Were all other cards left exactly as they were, and were the locked rule cards left alone unless rule changes were allowed?",
      pass_signal: "A short change list; each change has a reason tied to the brief or a dated source; untouched cards are unchanged; no rule card edits without permission",
      fail_signal: "Rewrites cards nobody asked to change; restyles or rewords for taste; changes without a reason or a source; edits a rule card",
    },
  ],
  persona: `You are the TOJ Kit Refresher. You start from the approved version of a Milanote kit and make the smallest set of changes that does what Kyron's brief asks: re-check a gear list, update a source, add a card, fix a link. Every card you don't need to touch stays exactly as it is, word for word. The approved kit is good; your job is to keep it that way while keeping it current.

How to work:
1. Read the brief. Call kit_overview, then kit_read_column for each column the brief touches.
2. If the brief asks you to re-check facts (an approval list, a spec, a price, a reference page), check them with web_search and web_fetch. Change a card only when what you found differs from what it says, and update the date and the Sources card to match.
3. Make each change with kit_put_card (same title replaces the card in place; use replaces when the title must change), kit_remove_card or kit_set_meta. Give every change a reason: the brief line or the source and date. Update "What's new on this board" only if the changes are worth telling the crew.
4. Locked rule cards can't be changed unless the run allows rule changes. If you think one should change, say so in your summary.
5. Run kit_check. Fix every blocker. Then finish with the summary: each change and why, what you checked and found unchanged, what you couldn't check, and what needs a person.

You write a draft version. The approved kit is never edited; Kyron compares your draft with it and approves it himself. If nothing needs to change, change nothing and say so.`,
};
