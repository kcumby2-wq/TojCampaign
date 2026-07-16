// Haiku-powered parser for Hooks' raw weekly stat pastes.
//
// Kyron (or Hooks) pastes something that looks like the Notes app screenshots:
//
//   Kaydon Finley Aledo HS 5-157-2
//   Mason James North Norman HS 10-144-2
//   Trenton Yancey Duncanville HS 187 APY-4
//
// This util calls Haiku with a strict JSON schema and returns structured rows:
//   { name, school_raw, receptions, rec_yards, rec_tds, apy, notes, raw }
//
// The route layer is responsible for matching name → hooks_athletes, previewing
// to the human, and committing to hooks_weekly_stats. This util is deliberately
// dumb: no DB, no matching, no side effects. Just paste → rows.

const Anthropic = require("@anthropic-ai/sdk").default;

const HAIKU = "claude-haiku-4-5";

const SYSTEM = `You are a football stat-line parser for Sky's The Limit WR (Coach Margin Hooks). You receive a paste of raw stat lines that look like they came from a Notes app and return structured JSON.

Each line typically follows one of these shapes:
  "Kaydon Finley Aledo HS 5-157-2"        → name, school, receptions-yards-tds
  "Trenton Yancey Duncanville HS 187 APY-4" → name, school, APY total-followed by TDs
  "Jordan Smith Waxahachie HS 4-81 110 APY" → name, school, rec-yards, then APY marker
  "Finn Smith Fairfield HS 3-87-3 211 APY" → name, school, rec-yards-tds, then APY

The stat block at the end is the important part. It's usually:
  rec-yards-tds   e.g. "5-157-2"   → receptions=5, rec_yards=157, rec_tds=2
  rec-yards       e.g. "6-110"     → receptions=6, rec_yards=110, rec_tds=null
  APY-tds         e.g. "187 APY-4" → apy=187, rec_tds=4, receptions=null, rec_yards=null
  N APY N         e.g. "137APY 2"  → apy=137, rec_tds=2

Common school suffixes/prefixes: HS, Fr. (Frisco), Fr. Wakeland, Pr. (Prosper), N. / North / N Forney, S. Grand Prairie, Mans. / Man. / M. Lakeridge, La Vega / LaVega, PrestonwoodCA, Calvary Academy, Bishop Lynch, Parish Episcopal, Frisco Legacy Ac.

Rules:
- Return ONLY valid JSON matching the requested schema. No prose, no markdown, no code fences.
- If a field is not present, use null.
- Preserve the school as written in "school_raw". Add "school_short" as the school with "HS" / "Ac." stripped and abbreviations expanded when obvious (e.g. "N. McKinney HS" → "North McKinney").
- "notes" captures any trailing marker like "GW TD", "OT", "APY" annotations that didn't fit numeric fields.
- Keep the exact original text in "raw" for every line.
- Skip empty lines. Do not invent lines.`;

const SCHEMA = {
  type: "object",
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          school_raw: { type: ["string", "null"] },
          school_short: { type: ["string", "null"] },
          receptions: { type: ["integer", "null"] },
          rec_yards: { type: ["integer", "null"] },
          rec_tds: { type: ["integer", "null"] },
          apy: { type: ["integer", "null"] },
          notes: { type: ["string", "null"] },
          raw: { type: "string" },
        },
        required: ["name", "raw"],
      },
    },
  },
  required: ["rows"],
};

async function parseStatPaste(paste) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }
  const client = new Anthropic();
  const message = await client.messages.create({
    model: HAIKU,
    max_tokens: 4000,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `Parse the stat lines below into JSON matching this schema:\n\n${JSON.stringify(SCHEMA)}\n\nStat lines:\n\n${paste}`,
      },
    ],
  });

  const text = message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  // Strip any accidental code fences.
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Haiku returned non-JSON: ${cleaned.slice(0, 200)}`);
  }
  if (!parsed.rows || !Array.isArray(parsed.rows)) {
    throw new Error("Haiku output missing 'rows' array");
  }
  return {
    rows: parsed.rows,
    usage: message.usage,
  };
}

module.exports = { parseStatPaste };
