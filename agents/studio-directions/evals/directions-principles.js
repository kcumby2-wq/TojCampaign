// Three Directions eval: "Are these three real, shootable ways to make this
// film, inside the lines?" The judge reads the film (no names) and the three
// directions submitted (agents/studio-directions/tools.js evalView).
// 5 questions × 0-2; below 7 = FAIL → retry with guidance.

const BANNED =
  "\\b(unlock\\w*|unleash\\w*|transform\\w*|elite\\w*|generational|next[- ]level|phenoms?|future\\s+stars?|game[- ]chang\\w*|supercharg\\w*|premier(?!e)\\w*|top[- ]notch|state[- ]of[- ]the[- ]art|revolutioni[sz]\\w*)";

module.exports = {
  id: "directions-principles",
  namespace: "studio-directions",
  applies_to: "*",
  scoring: { threshold: 7, max_retries: 3 },
  questions: [
    {
      id: "three_real_routes",
      prompt: "Are the three directions genuinely different ways into this film (different starting points or forms), each one a producer could choose, rather than one film three ways?",
      pass_signal: "Three distinct routes, each named, each complete",
      fail_signal: "Three versions of the same film, or one padded direction nobody would pick",
    },
    {
      id: "fits_the_film",
      prompt: "Does each direction fit the format's length and shape, the lane and the one-sentence story, with beats sized to the format and a reason it fits this speaker?",
      pass_signal: "Beats and length match the format; the story is served",
      fail_signal: "A 3-minute shape for a 15-second cutdown, a story that drifts, generic reasons",
    },
    {
      id: "shootable",
      prompt: "Could a director shoot each direction in a day from what's here: specific must-have shots, realistic risks with fallbacks, and nothing the cards don't allow (minors only wide and unidentifiable, no face where a release doesn't cover one)?",
      pass_signal: "Concrete shots, honest risks, every card respected",
      fail_signal: "Vague shots ('emotional moments'), no fallback, or a shot a card doesn't allow",
    },
    {
      id: "taste_used",
      prompt: "Where the taste library has fitting notes, do the directions draw on them and say what to take (a lesson, not a copy)?",
      pass_signal: "Relevant notes cited with a specific take",
      fail_signal: "Notes ignored when they fit, cited with no take, or used as shots to copy",
    },
    {
      id: "plain_words",
      prompt: "Is it written plainly: specific, short lines, no filler, no hype?",
      pass_signal: "Direct and concrete",
      fail_signal: "Padded, vague or salesy",
    },
  ],
  auto_fails: [
    { id: "no_directions", description: "The agent never submitted directions", check_type: "regex", pattern: "\\[directions\\] none", flags: "" },
    { id: "banned_vocabulary", description: "TOJ banned vocabulary", check_type: "regex", pattern: BANNED, flags: "i" },
    {
      id: "words_invented",
      check_type: "llm_check",
      description: "A line written for a real person",
      instruction: "Does any direction write, paraphrase or invent words for a real person to say (a quote, a line in their voice), rather than describing the kind of line to find? HIT if yes.",
    },
    {
      id: "minor_identified",
      check_type: "llm_check",
      description: "A minor named, described or made identifiable",
      instruction: "Does any direction ask for a minor's face, name, jersey number, school or team, or describe a young person identifiably? Wide, unidentifiable shots (hands, cleats, backs) are fine. HIT if yes.",
    },
  ],
};
