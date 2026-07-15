// Evaluator engine — runs quality guardrails against agent output before it
// reaches the human.
//
// Flow:
//   1. runProgrammaticChecks — regex + trace-based auto-fails (free, fast)
//   2. runScoredCheck — Haiku scores against the 5 questions (~$0.001)
//   3. On close call (score 6 or 7), escalate to Sonnet for a second opinion
//   4. Return { verdict, total_score, scores, biggest_miss, retry_guidance,
//               auto_fail_triggered, evaluator_model, usage }
//
// The orchestrator wraps runAgent() with a retry loop that calls this,
// appends retry_guidance to the next attempt, and stops after max_retries.

const Anthropic = require("@anthropic-ai/sdk").default;

const HAIKU = "claude-haiku-4-5";
const SONNET_ESCALATE = "claude-opus-4-8"; // for close-call second opinions
const CLOSE_CALL_LOW = 6;
const CLOSE_CALL_HIGH = 7;

function runProgrammaticChecks(spec, agentResult, contextIn) {
  const { output, trace } = agentResult;
  const { client_id_present } = contextIn;
  for (const rule of spec.auto_fails || []) {
    if (rule.check_type === "regex") {
      const re = new RegExp(rule.pattern, rule.flags || "");
      if (re.test(output)) {
        return {
          triggered: rule.id,
          description: rule.description,
          evidence: (output.match(re) || [])[0] || "",
        };
      }
    } else if (rule.check_type === "trace") {
      if (rule.requires_tool_call_when_scoped && client_id_present) {
        const called = (trace || []).some(
          (t) => t.type === "tool_use" && t.name === rule.requires_tool_call_when_scoped
        );
        if (!called) {
          return {
            triggered: rule.id,
            description: rule.description,
            evidence: `client_id was provided but ${rule.requires_tool_call_when_scoped} was never called`,
          };
        }
      }
    }
    // llm_check auto_fails run inside the scored check pass — cheaper to batch
  }
  return null;
}

function buildScoringPrompt(spec, agentResult, contextIn) {
  const llmChecks = (spec.auto_fails || []).filter((r) => r.check_type === "llm_check");
  const questionsBlock = spec.questions
    .map(
      (q, i) =>
        `Q${i + 1} — ${q.id}\n${q.prompt}\n  PASS signal: ${q.pass_signal}\n  FAIL signal: ${q.fail_signal}`
    )
    .join("\n\n");
  const llmChecksBlock = llmChecks.length
    ? `\n\n## Auto-fail checks (also evaluate — any HIT = auto-fail regardless of score):\n${llmChecks.map((c) => `- ${c.id}: ${c.instruction}`).join("\n")}`
    : "";

  return `You are an eval judge. Score the following agent output against the "${spec.id}" rubric.

The rubric has ${spec.questions.length} questions, each scored 0–2 (0 = fails the signal, 1 = partial, 2 = clearly passes).

## Rubric:
${questionsBlock}${llmChecksBlock}

## Agent role: ${agentResult.role} (${agentResult.label || agentResult.role})
## Client scope: ${contextIn.client_id_present ? "YES (client_id was provided)" : "NO (cross-client task)"}
## Tool calls the agent made: ${(agentResult.trace || []).filter((t) => t.type === "tool_use").map((t) => t.name).join(", ") || "(none)"}

## Agent output to score:
"""
${agentResult.output}
"""

Respond in this EXACT JSON structure (no prose outside the JSON):
{
  "scores": [
    {"question_id": "...", "score": 0-2, "justification": "one line"},
    ...
  ],
  "total": <sum>,
  "verdict": "PASS" | "FAIL",
  "biggest_miss": "the single most-important gap in one line",
  "retry_guidance": "one paragraph the retrying agent should add to fix this — actionable, specific",
  "auto_fail_hits": ["id_of_llm_check_that_fired", ...]
}

Verdict rule: total >= ${spec.scoring.threshold} AND auto_fail_hits is empty = PASS. Otherwise FAIL.`;
}

async function runScoredCheck(spec, agentResult, contextIn, model = HAIKU) {
  const client = new Anthropic();
  const prompt = buildScoringPrompt(spec, agentResult, contextIn);
  const resp = await client.messages.create({
    model,
    max_tokens: 1500,
    system:
      "You are a strict eval judge. You return only valid JSON matching the requested schema. You never soften a FAIL to preserve feelings. You score conservatively — a 2 requires clear evidence, not just absence of failure.",
    messages: [{ role: "user", content: prompt }],
  });

  const raw = resp.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  // Extract JSON — model may wrap in ```json ... ```
  let jsonStr = raw;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) jsonStr = fence[1].trim();
  const firstBrace = jsonStr.indexOf("{");
  const lastBrace = jsonStr.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    return {
      verdict: "FAIL",
      total_score: 0,
      scores: [],
      biggest_miss: "Evaluator returned non-JSON — treating as fail for safety",
      retry_guidance: "The eval judge failed to return valid JSON. Try again with a cleaner, more structured response.",
      auto_fail_triggered: "evaluator_parse_error",
      evaluator_model: model,
      usage: resp.usage,
    };
  }

  const autoFail = parsed.auto_fail_hits && parsed.auto_fail_hits.length > 0
    ? parsed.auto_fail_hits[0]
    : null;
  return {
    verdict: autoFail ? "FAIL" : (parsed.verdict || "FAIL"),
    total_score: parsed.total || 0,
    scores: parsed.scores || [],
    biggest_miss: parsed.biggest_miss || "",
    retry_guidance: parsed.retry_guidance || "",
    auto_fail_triggered: autoFail,
    evaluator_model: model,
    usage: resp.usage,
  };
}

async function evaluate(spec, agentResult, contextIn = {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { verdict: "PASS", total_score: null, scores: [], biggest_miss: "eval-skipped-no-key", retry_guidance: "", auto_fail_triggered: null, evaluator_model: null, usage: null };
  }

  // Fast path: programmatic checks first
  const progFail = runProgrammaticChecks(spec, agentResult, contextIn);
  if (progFail) {
    return {
      verdict: "FAIL",
      total_score: 0,
      scores: [],
      biggest_miss: progFail.description,
      retry_guidance: `Auto-fail triggered: ${progFail.description}. Evidence: "${progFail.evidence}". Rewrite avoiding this pattern.`,
      auto_fail_triggered: progFail.triggered,
      evaluator_model: "programmatic",
      usage: null,
    };
  }

  // Scored check with Haiku
  const result = await runScoredCheck(spec, agentResult, contextIn, HAIKU);

  // Close-call escalation: score 6 or 7 → get Sonnet's opinion
  if (
    result.total_score !== null &&
    result.total_score >= CLOSE_CALL_LOW &&
    result.total_score <= CLOSE_CALL_HIGH &&
    !result.auto_fail_triggered
  ) {
    try {
      const escalated = await runScoredCheck(spec, agentResult, contextIn, SONNET_ESCALATE);
      // Sonnet's opinion wins on close calls
      return {
        ...escalated,
        evaluator_model: `${HAIKU}+${SONNET_ESCALATE}`,
        haiku_score: result.total_score,
        haiku_verdict: result.verdict,
      };
    } catch (e) {
      console.error("[eval] close-call escalation failed:", e.message);
      return result; // fall back to Haiku's opinion
    }
  }

  return result;
}

module.exports = { evaluate, HAIKU, SONNET_ESCALATE };
