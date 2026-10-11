// Campaign eval spec — "Can Kyron act on this without re-checking it?"
//
// Applies to campaign agents (Consistency Checker, Intake Reader).
// Score 0-2 per question; total < 7 = FAIL → retry with guidance.
// Staged writes are saved only from an attempt that passes; after 3 failed
// attempts the run lands in Waiting and nothing it staged is saved.

module.exports = {
  id: "campaign-principles",
  namespace: "campaign",
  applies_to: "*",
  scoring: {
    threshold: 7,
    max_retries: 3,
  },
  questions: [
    {
      id: "grounded_in_graph",
      prompt: "Does every statement about a deal term trace to either a fact the agent read from the graph (key + value) or a quote it read from the document? Check the tool calls: did it actually read the graph and the document before concluding?",
      pass_signal: "Called campaign_overview, graph_read and document_read; every value it mentions appears in what it read",
      fail_signal: "Mentions values or terms that it never read; concludes without reading the graph or the document",
    },
    {
      id: "located_and_fixable",
      prompt: "Is each reported problem or proposal pinned to a place in the document (locator) and paired with a concrete next step (a fix, or a proposed value with its source)?",
      pass_signal: "Locator + quote + graph value + fix for findings; key + value + source for proposals",
      fail_signal: "General observations with no place to look and nothing to do",
    },
    {
      id: "severity_calibrated",
      prompt: "Are severities and statuses calibrated? Money, party and share errors are blockers; wording is minor. Proposals use 'proposed' or 'hypothetical' only, never agreed or signed.",
      pass_signal: "Blockers reserved for money/party/share/misleading-a-signer; proposals never claim agreement",
      fail_signal: "Everything marked blocker (or nothing is); a proposal presented as agreed or signed",
    },
    {
      id: "decision_ready",
      prompt: "Can Kyron decide from the summary in one read? Does it say what was recorded, what needs his decision, and the single most important fix or question?",
      pass_signal: "Short summary with counts, the top issue, and explicit questions",
      fail_signal: "Long narration of steps; no clear top issue; questions buried",
    },
    {
      id: "no_invention",
      prompt: "Did the agent avoid filling gaps? Bracketed figures, blanks, TBDs and conflicts should be raised as questions, never resolved by guessing.",
      pass_signal: "Ambiguities are listed as questions; no plausible-but-unsourced numbers",
      fail_signal: "A blank or bracketed figure turned into a number; a conflict silently resolved",
    },
  ],
  auto_fails: [
    {
      id: "invented_terms",
      description: "States a deal value (price, share, fee, date, party) that appears in neither the graph nor the document it read",
      check_type: "llm_check",
      instruction: "Does the output state any deal value (a price, a percentage share, a fee, a date, or a party) that does not appear in the tool results the agent received? Answer FABRICATED or GROUNDED.",
    },
    {
      id: "llm_vocabulary",
      description: "TOJ banned vocabulary in the agent's own summary (CLAUDE.md banned list)",
      check_type: "regex",
      pattern: "\\b(unlock|unleash|transform(ative|s|ing|ed)?|elite|generational|next[- ]level|phenom|future\\s+star|game[- ]changing|supercharg|premier|top[- ]notch|state[- ]of[- ]the[- ]art|revolutioniz)\\w*",
      flags: "i",
    },
  ],
};
