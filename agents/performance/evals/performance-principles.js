// Performance eval spec — "Was this done the recruiting-fog-reducer way?"
//
// Applies to all performance-os agent outputs (Session Report Generator,
// Coach Scout Reporter, Progress Tracker, Event Coordinator, Device
// Reliability). Score 0-2 per question; total < 7 = FAIL → retry with
// guidance. After 3 retries, the run lands in Waiting for human review.
//
// The 7 rules the spec is derived from live in
// performance-os/skills/recruiting-fog-reducer/SKILL.md.

module.exports = {
  id: "performance-principles",
  namespace: "performance",
  applies_to: "*",
  scoring: {
    threshold: 7,
    max_retries: 3,
  },
  questions: [
    {
      id: "sample_size_honest",
      prompt: "Does the output name its sample size and treat thin data as thin? Is anything with <3 sessions explicitly marked 'preview / not scout-grade,' with no over-claim on what a single session or a partial cohort actually proves?",
      pass_signal: "Session count stated up front; preview / provisional markers where sample is thin; no scout-grade claim from a single datum",
      fail_signal: "Assertive scout claim from 1 session; 'consistent' or 'reliable' pattern claimed from ≤2 data points; no visible sample size",
    },
    {
      id: "percentile_anchored",
      prompt: "Is every measured metric anchored to a percentile band or a benchmark, not left as a raw number floating alone? '15.9 mph top speed' means nothing to a college coach without 'X percentile for WR at age tier Y.'",
      pass_signal: "Every stat carries a percentile band, a cohort comparison, or a benchmark reference from the benchmarks table (real or stubbed with a labeled placeholder)",
      fail_signal: "Raw numbers with no context; percentiles referenced generically without band; missing benchmark anchor for the position × age tier",
    },
    {
      id: "position_fluent",
      prompt: "Does the framing use position-specific language a scout would recognize (route-runner, burst, change-of-direction workload, contact-adjacent metrics)? Would a college position coach nod along, or does it read like generic 'good athlete' copy?",
      pass_signal: "Position-fluent terminology; framing tied to how the athlete's data maps to their position's demands; scheme-fit language when warranted",
      fail_signal: "Generic athletic-praise copy; wrong position framing; no scheme or role projection connected to the data",
    },
    {
      id: "trend_over_snapshot",
      prompt: "For any monthly / multi-session report, does the output lead with trend and delta, not snapshot? Even in a low-activity month, does it find and surface real trend signal (or honestly say 'held steady, here's the 3-month context')?",
      pass_signal: "Delta vs prior period stated; trend framing leads; flat months addressed honestly with longer-window context",
      fail_signal: "Single-session snapshot presented as a scout report; no delta section on a monthly artifact; silence on a flat month",
    },
    {
      id: "operator_ready_no_placeholders",
      prompt: "Does the output ship a decision the operator can send with one review pass — concrete metrics, real athlete first name, no [FILL IN] tokens, no 'ask their trainer for X' handoffs the agent should have handled?",
      pass_signal: "Zero placeholder tokens; the report is send-ready or preview-ready with a single review pass",
      fail_signal: "Has [FILL IN] / [TBD] / [insert X] markers; asks the operator to look up data the agent had access to; creates >5 min of human work when 1 min was possible",
    },
  ],
  auto_fails: [
    {
      id: "hype_vocabulary",
      description: "Uses forbidden vocabulary — 'elite,' 'generational,' 'next-level,' 'phenom,' 'future star,' 'unlock,' 'transform,' 'game-changing,' 'unleash,' 'supercharge,' 'in today's fast-paced world,' 'are you ready to'",
      check_type: "regex",
      pattern: "\\b(elite|generational|next[- ]level|phenom|future\\s+star|unlock|unleash|transform(ative|s|ing|ed)?|game[- ]changing|supercharg|in today['’]s fast[- ]paced|are you ready to)\\b",
      flags: "i",
    },
    {
      id: "hype_triples",
      description: "Adjective triples in the profile framing ('bold, dynamic, and revolutionary')",
      check_type: "regex",
      pattern: "\\b(bold|dynamic|revolutionary|innovative|cutting[- ]edge|world[- ]class|premier|leading)\\s*,\\s*(bold|dynamic|revolutionary|innovative|cutting[- ]edge|world[- ]class|premier|leading)\\s*,?\\s*(and\\s+)?(bold|dynamic|revolutionary|innovative|cutting[- ]edge|world[- ]class|premier|leading)\\b",
      flags: "i",
    },
    {
      id: "exclamation_marks",
      description: "Exclamation marks in scout-report body copy (banned in coach-facing artifacts)",
      check_type: "regex",
      pattern: "!",
    },
    {
      id: "pro_comparison_without_evidence",
      description: "Compares the athlete to a named pro without a measured basis — this is the credibility-killer college coaches burn the source for",
      check_type: "regex",
      pattern: "\\b(the next|reminds me of|comparable to|in the mold of)\\s+[A-Z][a-z]+\\s+[A-Z][a-z]+\\b",
      flags: "",
    },
    {
      id: "invented_athlete_facts",
      description: "When a client_id (athlete_id) was provided but the agent never called retrieve_client_context to ground the profile in stored data",
      check_type: "trace",
      requires_tool_call_when_scoped: "retrieve_client_context",
    },
  ],
};
