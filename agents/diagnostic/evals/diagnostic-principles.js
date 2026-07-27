// Diagnostic eval spec — "Was this done the $999-Model way?"
//
// Applies to all diagnostic agent outputs (Discovery Analyst, Opportunity
// Mapper, Report Architect, Offer Strategist, Pipeline Hunter).
// Score 0-2 per question; total < 7 = FAIL → retry with guidance.
// After 3 retries, the run lands in Waiting with full history.

module.exports = {
  id: "diagnostic-principles",
  namespace: "diagnostic",
  applies_to: "*",
  scoring: {
    threshold: 7,
    max_retries: 3,
  },
  questions: [
    {
      id: "roi_lever_named",
      prompt: "Does every recommended opportunity name which of the 3 ROI levers it pulls — (1) Make more money / effectiveness, (2) Save time / efficiency, (3) Increase quality of product or service? An opportunity that pulls none of the three should not be recommended at all.",
      pass_signal: "Each opportunity tagged to at least one lever, with the mechanism stated (what changes, for whom)",
      fail_signal: "Recommends a tool 'because it's cool' with no lever; vague 'improve operations' with no lever named",
    },
    {
      id: "grounded_in_transcript",
      prompt: "Is every pain point and opportunity traceable to something the business owner actually said in the transcript (or in retrieved client memory when scoped)? No invented pains, no generic pains that could apply to any business.",
      pass_signal: "Pains quote or paraphrase the owner's own words; opportunities map to a stated bottleneck",
      fail_signal: "Generic pain list ('you probably struggle with lead follow-up'); invented facts; no evidence from the call",
    },
    {
      id: "effort_impact_honest",
      prompt: "Is the effort-vs-impact read honest — quick wins are genuinely low-effort AND point at a real pain, and high-effort projects are labeled as such rather than sold as quick wins? Does the report focus first on low-effort / high-impact?",
      pass_signal: "Priority matrix separates quick wins from major projects; nothing high-effort is disguised as a quick win",
      fail_signal: "Everything labeled 'easy'; a 3-week build sold as a '4-day quick win'; no effort discrimination",
    },
    {
      id: "ships_a_decision",
      prompt: "Does the output ship a decision the operator can act on with one review pass — no [FILL IN] placeholders, concrete tools/steps/numbers — rather than homework? Financial impact stated concretely ('$X/mo for Y hrs/week') not hand-waved?",
      pass_signal: "Named tools, concrete 4-day steps, a specific dollar/hours figure with the reasoning shown",
      fail_signal: "Placeholders; 'research some tools'; ROI asserted with no math; asks the operator to make calls the agent should have made",
    },
    {
      id: "phase_discipline",
      prompt: "Did the role stay in its lane? Discovery Analyst PROBES and does not prescribe tools (first-call rule). Opportunity Mapper maps but doesn't write the client report. Report Architect assembles but doesn't invent new pains. Offer Strategist recommends a tier grounded in the client's stated urgency/timeline/DIY-preference.",
      pass_signal: "Output matches the role's phase; no prescribing on discovery; offer tier justified by the 3 closing answers",
      fail_signal: "Discovery Analyst jumps to 'you should buy Zapier'; Offer Strategist picks a tier with no basis in what the client said",
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
      id: "invented_client_facts",
      description: "When a client_id was provided but the agent never called retrieve_client_context to ground the analysis",
      check_type: "trace",
      requires_tool_call_when_scoped: "retrieve_client_context",
    },
  ],
};
