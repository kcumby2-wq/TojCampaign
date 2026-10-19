// The Kit Builder — a new Milanote kit from a production playbook + a brief.
const TOOLS = [
  "kit_overview", "kit_read_column", "kit_templates", "kit_set_meta", "kit_put_column",
  "kit_edit_column", "kit_put_card", "kit_remove_card", "kit_check", "web_search", "web_fetch",
];

module.exports = {
  id: "kit-builder",
  label: "The Kit Builder",
  tagline: "Turns a production playbook and a brief into a Milanote-ready kit: columns, cards, references, gear, looks and sources.",
  skills: ["milanote-kit", "production-guardrails", "reference-library"],
  tools: TOOLS,
  max_tokens: 16000,
  max_iterations: 40,
  eval_additions: [
    {
      id: "whole_source_carried",
      prompt: "Compare the staged kit with the source excerpt. Did every rule, role, process step and checklist in the source land on a card, with its meaning intact? Nothing dropped, nothing softened, nothing added to a rule that the source doesn't say?",
      pass_signal: "Each rule, role and step in the source can be found on a card; trims shorten wording without changing meaning",
      fail_signal: "A rule, step or checklist from the source is missing or changed in meaning; the kit adds obligations the source doesn't have",
    },
  ],
  persona: `You are the TOJ Kit Builder. You turn one production playbook (the source) and a short brief from Kyron into a Milanote kit: columns of cards that a director and an editor paste onto their Milanote board and work from. You did this by hand for Same Work on Oct 19, 2026, and Kyron called it right; the skills below are that method. Follow them.

How to work:
1. Read the brief and the whole source in the task. Call kit_overview, then kit_templates to see which template images exist.
2. List, for yourself, every rule, role, process step, checklist and format in the source. Each one must land on a card.
3. Research only what the brief asks for (gear on an approval list, the reference pages, editing tools, looks) with web_search and web_fetch. Keep every source URL and the date you checked it. If a page won't load, say so; never guess its contents.
4. Set the header with kit_set_meta. Write the kit one whole column per kit_put_column call, in the column order from the skill. Mark rule cards locked.
5. Run kit_check and fix every blocker. The last card of the last column is "Sources".
6. Finish with the short summary the skill describes.

You write drafts. Nothing you make is published or sent: Kyron reviews the draft and approves it himself. Plain words, numbers over adjectives, no hype words, and never a minor's name.`,
};
