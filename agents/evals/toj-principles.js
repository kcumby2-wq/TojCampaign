// TOJ eval spec — "Was this done the TOJ Foundation way?"
//
// Applies to all TOJ agent outputs (Coach, Closer, CFO, Skeptic, Warmer, Architect).
// Score 0-2 per question; total < 7 = FAIL → retry with guidance.
// After 3 retries, the run lands in Waiting with full history.

module.exports = {
  id: "toj-principles",
  namespace: "toj",
  applies_to: "*", // all roles in namespace
  scoring: {
    threshold: 7,
    max_retries: 3,
  },
  questions: [
    {
      id: "pillar_first",
      prompt: "Did the work name which of the 5 Foundation pillars this addresses (Brand Identity, Operational Health, Revenue Architecture, Content & Credibility, Growth Readiness)? Weakest-pillar diagnosis grounded in retrieval, not the sexiest one?",
      pass_signal: "Named the pillar + evidence from client memory + intervention",
      fail_signal: "Generic advice, no pillar reference, or pillar named without evidence",
    },
    {
      id: "ev_discipline",
      prompt: "Was the impact ceiling considered before writing? Is this a load-bearing move for this client, or polish on something that doesn't move the number?",
      pass_signal: "Recommends a move whose outcome could plausibly shift a real metric (revenue, retention, credibility, capacity)",
      fail_signal: "Polished output on a low-ceiling topic; work with no stated expected outcome",
    },
    {
      id: "operator_time_minimized",
      prompt: "Ships directly to the client, or does the human have to edit before it goes out? Is it a decision (good) or homework (bad)?",
      pass_signal: "No [FILL IN] placeholders; ready to send/approve with one review pass",
      fail_signal: "Has placeholders; asks the operator to make judgment calls the agent should have made; creates >5min of human work when 1min was possible",
    },
    {
      id: "grounded_in_memory",
      prompt: "Every quote, claim, and voice choice traceable to retrieved client_documents via retrieve_client_context? No fabricated tone, no invented facts about the client?",
      pass_signal: "Verifiable phrases from the client's own words; retrieved chunks cited or clearly used",
      fail_signal: "Wrote 'in the client's voice' without calling retrieve_client_context first; invented client details; generic marketing tone",
    },
    {
      id: "leverage_check",
      prompt: "Reusable pattern surfaced, or one-off? Did we use an existing skill/template, or waste effort rebuilding?",
      pass_signal: "Uses the toj-voice/methodology skills; ships something that maps to a repeatable pattern",
      fail_signal: "Bespoke work when a skill or prior deliverable would have shaped the output faster",
    },
  ],
  auto_fails: [
    {
      id: "llm_vocabulary",
      description: "Uses forbidden vocabulary — 'unlock', 'transform', 'elevate', 'unleash', 'journey', 'game-changing', 'next-level', 'supercharge', 'in today's fast-paced world', 'are you ready to', 'imagine a world where'",
      check_type: "regex",
      pattern: "\\b(unlock|unleash|transform(ative|s|ing|ed)?|elevate|elevated|journey|game[- ]changing|next[- ]level|supercharg|in today['’]s fast[- ]paced|are you ready to|imagine a world where)\\b",
      flags: "i",
    },
    {
      id: "hype_triples",
      description: "Adjective triples ('bold, dynamic, and revolutionary')",
      check_type: "regex",
      pattern: "\\b(bold|dynamic|revolutionary|innovative|cutting[- ]edge|world[- ]class|premier|leading)\\s*,\\s*(bold|dynamic|revolutionary|innovative|cutting[- ]edge|world[- ]class|premier|leading)\\s*,?\\s*(and\\s+)?(bold|dynamic|revolutionary|innovative|cutting[- ]edge|world[- ]class|premier|leading)\\b",
      flags: "i",
    },
    {
      id: "exclamation_marks",
      description: "Exclamation marks in TOJ body copy",
      check_type: "regex",
      pattern: "!",
    },
    {
      id: "invented_client_facts",
      description: "When a client_id was provided but the agent never called retrieve_client_context",
      check_type: "trace",
      requires_tool_call_when_scoped: "retrieve_client_context",
    },
  ],
};
