// Brief Writer eval — "Would the kit agent do what Kyron meant, from this
// brief alone?" The judge reads the idea and the references as Kyron gave
// them, and the brief that was submitted (agents/studio-brief/tools.js
// evalView). 5 questions × 0-2; below 7 = FAIL → retry with guidance.

const BANNED =
  "\\b(unlock\\w*|unleash\\w*|transform\\w*|elite\\w*|generational|next[- ]level|phenoms?|future\\s+stars?|game[- ]chang\\w*|supercharg\\w*|premier(?!e)\\w*|top[- ]notch|state[- ]of[- ]the[- ]art|revolutioni[sz]\\w*)";

module.exports = {
  id: "brief-principles",
  namespace: "studio-brief",
  applies_to: "*",
  scoring: { threshold: 7, max_retries: 3 },
  questions: [
    {
      id: "faithful_to_idea",
      prompt: "Does the brief ask for what Kyron's idea asks for: no less, and nothing he didn't ask for? Where the idea was unclear, did the agent choose sensibly and ask, rather than guess silently or widen the scope?",
      pass_signal: "Goal matches the idea; scope is the smallest that does it; unclear points become questions",
      fail_signal: "Brief drifts from the idea, adds work he didn't ask for, or fills gaps without saying so",
    },
    {
      id: "references_used",
      prompt: "Is every reference turned into concrete words the kit agent can use (what it shows, what to take, what to leave), with links kept as URLs? Does it say plainly when a link didn't load or a video's words weren't available?",
      pass_signal: "Each reference has specific, usable notes; unloaded or partial references are marked",
      fail_signal: "References summarized vaguely ('nice vibe'), skipped, or described as if fully seen when they weren't",
    },
    {
      id: "actionable",
      prompt: "Could the kit agent act on the brief without guessing? Mode and kit named; changes as numbered steps naming the exact column and card; what to leave alone; how Kyron will know it worked.",
      pass_signal: "Goal, kit, numbered Do steps with real card names, Leave alone, Done when",
      fail_signal: "Vague asks ('make it better'), no card names, no done criteria",
    },
    {
      id: "inside_the_lines",
      prompt: "Does the brief stay inside the production rules: no minors identified, real words only, no marks we don't own, no banned tools, new looks and formats marked proposed, rule changes raised as questions rather than steps?",
      pass_signal: "Nothing in the brief asks the kit agent to cross a line; conflicts are named as questions",
      fail_signal: "Asks for something the rules forbid, or presents a rule change as a step",
    },
    {
      id: "plain_and_tight",
      prompt: "Is the brief plain and tight: short lines, numbers over adjectives, under about 400 words, with no filler?",
      pass_signal: "Scannable, concrete, short",
      fail_signal: "Long, padded or full of adjectives",
    },
  ],
  auto_fails: [
    { id: "no_brief", description: "The agent never submitted a brief", check_type: "regex", pattern: "\\[brief\\] none", flags: "" },
    { id: "banned_vocabulary", description: "TOJ banned vocabulary (Adobe Premiere Pro is fine)", check_type: "regex", pattern: BANNED, flags: "i" },
    { id: "banned_phrases", description: "Guaranteed exposure / placement", check_type: "regex", pattern: "\\bguaranteed\\s+(exposure|placement)\\b", flags: "i" },
    {
      id: "minor_identified",
      check_type: "llm_check",
      description: "A minor named, described or made identifiable",
      instruction: "In the submitted brief and reference notes: does anything name a minor, describe a young person's face or identifying features, or give a youth athlete's school, team, jersey number or contact? Describing visual style (light, framing, grain) is fine. HIT if yes.",
    },
    {
      id: "claims_unseen",
      check_type: "llm_check",
      description: "Claims about what a video says or a page shows that the agent couldn't have seen",
      instruction: "Does the brief or a reference note state what someone in a video says, what its music or audio is, or describe the contents of a link marked 'not loaded' beyond Kyron's own caption? HIT if yes.",
    },
    {
      id: "crosses_a_line",
      check_type: "llm_check",
      description: "The brief asks the kit agent to break a production rule",
      instruction: "Does the brief ask for AI voices or AI-written quotes, identifying Texas youth athletes, team/NFL/school marks, CapCut or other banned tools on footage, a vintage look that passes new footage off as old, publishing anything, or changing a locked rule card as a 'Do' step? HIT if yes.",
    },
  ],
};
