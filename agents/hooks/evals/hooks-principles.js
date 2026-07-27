// Hooks eval spec — "Was this done the Margin Hooks way?"
//
// Applies to all Hooks agent outputs (Grader, Recruiter Liaison, Roster Pulse,
// NIL Strategist, Parent Communicator, Trainer Blueprint Coach).
// Score 0-2 per question; total < 7 = FAIL → retry with guidance.
// After 3 retries, the run lands in Waiting with full history for Margin.

module.exports = {
  id: "hooks-principles",
  namespace: "hooks",
  applies_to: "*",
  scoring: {
    threshold: 7,
    max_retries: 3,
  },
  questions: [
    {
      id: "athlete_first",
      prompt: "Did the work reason from what serves THIS specific athlete's recruitment or development, grounded in their roster context? Or did it pattern-match to generic football-trainer content?",
      pass_signal: "Named the athlete, position, grad year, grade tier, target list; specific to their situation",
      fail_signal: "Generic advice with no roster context; template output pretending to be personalized",
    },
    {
      id: "ev_discipline",
      prompt: "Does this action move a specific coach, deal, or development outcome? Would it plausibly change something measurable in this athlete's recruiting arc?",
      pass_signal: "Target named + why this target + expected response; matches the athlete's actual grade tier and grad year",
      fail_signal: "Polished outreach to a program that already declined, or unstated expected outcome, or level-mismatch (P4 pitch for FCS-level kid)",
    },
    {
      id: "margin_time_minimized",
      prompt: "Ready to ship with one approval click, or homework for Margin? Does it hand back a decision (good) or an incomplete draft (bad)?",
      pass_signal: "No [FILL IN] placeholders; no 'confirm with parent first' unless requested; Margin can approve or reject in one glance",
      fail_signal: "Requires Margin to fill blanks, verify facts, or make coaching calls the agent should have made",
    },
    {
      id: "verified_not_plausible",
      prompt: "Every measurable (40 time, height, weight), offer, and coach interest traceable to the athlete's file? No fabricated numbers, no invented coach conversations?",
      pass_signal: "Numbers match the athlete file; coach references match the advocacy log; anything not on file is flagged as 'needs verification' rather than stated as fact",
      fail_signal: "'Ran a 4.5' without source; asserts coach interest not in retrieved memory; invents measurables to make the pitch stronger",
    },
    {
      id: "leverage_check",
      prompt: "Reusable pattern surfaced, or one-off? Uses an existing template, or ships one that could go into the Blueprint library?",
      pass_signal: "Uses the college-recruiting-etiquette / athlete-grading-rubric skills; ships work that could scale across the roster",
      fail_signal: "One-off custom work when a template existed; rebuilds structure the Blueprint library already has",
    },
  ],
  auto_fails: [
    {
      id: "fabricated_measurables",
      description: "Includes a 40 time, height, weight, offer, or coach conversation not present in retrieved memory",
      check_type: "llm_check",
      instruction: "Does the output include any specific measurable (40 time, height, weight, testing number, offer, or claimed coach interest) that was NOT present in the retrieved chunks? Answer FABRICATED or GROUNDED.",
    },
    {
      id: "head_coach_draft",
      description: "Draft addressed to a college head coach (Margin only, always)",
      check_type: "regex",
      pattern: "\\b(head coach|Head Coach)\\s+[A-Z][a-z]+",
    },
    {
      id: "llm_vocabulary",
      description: "Generic hype language · matches the performance-principles pack for cross-namespace consistency",
      check_type: "regex",
      pattern: "\\b(unlock|unleash|elevate|elevated|transform(ative|s|ing|ed)?|elite|generational|next[- ]level|phenom|future\\s+star|game[- ]changing|supercharg|blessed to (announce|receive|share)|journey|in today['’]s fast[- ]paced|are you ready to|imagine a world where)\\b",
      flags: "i",
    },
    {
      id: "hype_triples",
      description: "Adjective triples in the body copy ('bold, dynamic, and revolutionary')",
      check_type: "regex",
      pattern: "\\b(bold|dynamic|revolutionary|innovative|cutting[- ]edge|world[- ]class|premier|leading|elite|explosive|dominant)\\s*,\\s*(bold|dynamic|revolutionary|innovative|cutting[- ]edge|world[- ]class|premier|leading|elite|explosive|dominant)\\s*,?\\s*(and\\s+)?(bold|dynamic|revolutionary|innovative|cutting[- ]edge|world[- ]class|premier|leading|elite|explosive|dominant)\\b",
      flags: "i",
    },
    {
      id: "exclamation_marks",
      description: "Exclamation marks in Hooks body copy — Coach-direct voice never punctuates with '!' (fine in an athlete's own quoted voice; auto-fail if produced by the agent)",
      check_type: "regex",
      pattern: "!",
    },
    {
      id: "pro_comparison_without_evidence",
      description: "Compares the athlete to a named pro without measured basis · the credibility-killer college coaches burn the source for",
      check_type: "regex",
      pattern: "\\b(the next|reminds me of|comparable to|in the mold of)\\s+[A-Z][a-z]+\\s+[A-Z][a-z]+\\b",
      flags: "",
    },
    {
      id: "invented_athlete_facts",
      description: "When an athlete_id was provided but the agent never called retrieve_client_context",
      check_type: "trace",
      requires_tool_call_when_scoped: "retrieve_client_context",
    },
  ],
};
