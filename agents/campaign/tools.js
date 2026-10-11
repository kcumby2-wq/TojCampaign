// Campaign pack tools — built fresh for every run attempt, bound to one
// campaign. The model never names a tenant or campaign; the run does.
//
// Reads go to the database as 'agent:<role>'. Writes are STAGED in memory,
// not written: the route commits the stage from the attempt that passed the
// eval (agents/campaign/data.js commitStage), so a retried attempt never
// leaves duplicate claims or findings behind. Agents can't approve anything —
// there is no tool for it, and the database refuses an agent actor anyway.

const { betaTool } = require("@anthropic-ai/sdk/helpers/beta/json-schema");
const { withActor } = require("../../utils/campaign-db");
const data = require("./data");

function newStage() {
  return { claims: {}, findings: [], facts: { summary: "", set: [], remove: [] } };
}

function json(x) {
  return JSON.stringify(x, null, 2);
}

function err(e) {
  if (e && e.code === "bad_input") return `Refused: ${e.message}`;
  return `Error: ${e && e.message ? e.message : "failed"}`;
}

// ctx = { role, scope } where scope = { tenant_id, campaign_id, onStage(stage) }
function toolsFor(ctx) {
  const scope = ctx && ctx.scope;
  if (!scope || !data.isUuid(scope.tenant_id) || !data.isUuid(scope.campaign_id)) {
    throw new Error("campaign tools need a campaign scope");
  }
  const bound = { tenant_id: scope.tenant_id, campaign_id: scope.campaign_id };
  const actor = `agent:${ctx.role}`;
  const stage = newStage();
  if (typeof scope.onStage === "function") scope.onStage(stage);

  const read = (fn) => withActor(actor, (c) => fn(c));

  const campaignOverview = betaTool({
    name: "campaign_overview",
    description:
      "The campaign in scope: name, status, graph versions (which are approved, which one is open, open blockers) and its documents with their latest version ids. Call this first.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      try {
        return json(
          await read(async (c) => ({
            campaign: await data.campaignHeader(c, bound),
            versions: await data.versions(c, bound),
            documents: await data.listDocuments(c, bound),
          }))
        );
      } catch (e) {
        return err(e);
      }
    },
  });

  const graphRead = betaTool({
    name: "graph_read",
    description:
      "The deal graph — every fact (key, kind, value, status, source) as it stood at one version. Leave version out for the latest approved version (or the open proposal if nothing is approved yet).",
    inputSchema: {
      type: "object",
      properties: { version: { type: "integer", minimum: 1 } },
    },
    run: async ({ version } = {}) => {
      try {
        return json(await read((c) => data.graphAt(c, bound, version)));
      } catch (e) {
        return err(e);
      }
    },
  });

  const graphDiff = betaTool({
    name: "graph_diff",
    description: "What changed between two graph versions: added, removed and changed facts with old and new values.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "integer", minimum: 0 },
        to: { type: "integer", minimum: 1 },
      },
      required: ["from", "to"],
    },
    run: async ({ from, to }) => {
      try {
        return json(await read((c) => data.graphDiff(c, bound, from, to)));
      } catch (e) {
        return err(e);
      }
    },
  });

  const documentRead = betaTool({
    name: "document_read",
    description:
      "Read one document version in this campaign: its text, the graph version it was built against, and any claims already recorded for it.",
    inputSchema: {
      type: "object",
      properties: { version_id: { type: "string", description: "A document version id from campaign_overview." } },
      required: ["version_id"],
    },
    run: async ({ version_id }) => {
      try {
        const out = await read(async (c) => {
          const v = await data.documentVersion(c, bound, version_id);
          if (!v) return null;
          return { ...v, claims: await data.claimsFor(c, bound, version_id) };
        });
        return out ? json(out) : "Not found: no such document version in this campaign.";
      } catch (e) {
        return err(e);
      }
    },
  });

  const voiceCheck = betaTool({
    name: "voice_check",
    description:
      "Deterministic check of one document version for TOJ banned vocabulary. Returns each hit with its line number. Use this rather than scanning by eye.",
    inputSchema: {
      type: "object",
      properties: { version_id: { type: "string" } },
      required: ["version_id"],
    },
    run: async ({ version_id }) => {
      try {
        const v = await read((c) => data.documentVersion(c, bound, version_id));
        if (!v) return "Not found: no such document version in this campaign.";
        return json({ version_id, hits: data.lintVoice(v.body) });
      } catch (e) {
        return err(e);
      }
    },
  });

  const openFindings = betaTool({
    name: "open_findings",
    description: "Findings already open on this campaign. Check before raising one so you don't repeat it.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      try {
        return json(await read((c) => data.findings(c, bound, { status: "open" })));
      } catch (e) {
        return err(e);
      }
    },
  });

  const claimsWrite = betaTool({
    name: "claims_write",
    description:
      "Record what a document version claims: each claim is a locator ('Schedule M ¶1', 'slide 9'), the exact quote, the fact keys it states, and the value it asserts. Staged; saved when the run is accepted.",
    inputSchema: {
      type: "object",
      properties: {
        version_id: { type: "string" },
        claims: {
          type: "array",
          items: {
            type: "object",
            properties: {
              locator: { type: "string" },
              quote: { type: "string" },
              fact_keys: { type: "array", items: { type: "string" } },
              stated: { description: "The value the words assert, in the fact's value shape." },
              confidence: { type: "number", minimum: 0, maximum: 1 },
            },
            required: ["locator", "quote"],
          },
        },
      },
      required: ["version_id", "claims"],
    },
    run: async ({ version_id, claims }) => {
      try {
        const v = await read((c) => data.documentVersion(c, bound, version_id));
        if (!v) return "Refused: no such document version in this campaign.";
        const checked = (claims || []).map(data.checkClaim);
        stage.claims[version_id] = (stage.claims[version_id] || []).concat(checked);
        return `Staged ${checked.length} claim(s) for version ${version_id}.`;
      } catch (e) {
        return err(e);
      }
    },
  });

  const findingsWrite = betaTool({
    name: "findings_write",
    description:
      "Raise findings: where a document disagrees with the graph (value_mismatch), was built on an old version (stale), disagrees with another document (cross_document), has wrong arithmetic, breaks a policy, misses a disclosure, makes a claim tied to no fact (unbound_claim), or uses banned vocabulary (banned_word). Severity: blocker (wrong money, wrong party, legal exposure), major, minor. Staged; saved when the run is accepted. A person fixes or waives them.",
    inputSchema: {
      type: "object",
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: { type: "string" },
              severity: { type: "string", enum: ["blocker", "major", "minor"] },
              message: { type: "string", description: "What is wrong and where, in plain words." },
              fix: { type: "string", description: "The suggested change." },
              fact_key: { type: "string" },
              version_id: { type: "string", description: "The document version it is about." },
              graph_version: { type: "integer", minimum: 1 },
              claim_ids: { type: "array", items: { type: "string" } },
            },
            required: ["kind", "severity", "message"],
          },
        },
      },
      required: ["findings"],
    },
    run: async ({ findings }) => {
      try {
        const checked = (findings || []).map(data.checkFinding);
        stage.findings.push(...checked);
        return `Staged ${checked.length} finding(s).`;
      } catch (e) {
        return err(e);
      }
    },
  });

  const factsPropose = betaTool({
    name: "facts_propose",
    description:
      "Propose changes to the deal graph from what a document says. Goes into the campaign's open proposed version; a person reviews and approves it. Agents may only use status 'proposed' or 'hypothetical'. Staged; saved when the run is accepted.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One line: what this proposal changes and from which source." },
        set: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string", description: "e.g. split.pylon.event_sales" },
              kind: { type: "string" },
              value: { description: "The fact's value (object)." },
              status: { type: "string", enum: ["proposed", "hypothetical"] },
              source: { type: "string", description: "Where it comes from, e.g. 'Pylon v11 §8(d)'." },
            },
            required: ["key", "kind", "value", "status"],
          },
        },
        remove: { type: "array", items: { type: "string" } },
      },
      required: ["summary"],
    },
    run: async ({ summary, set = [], remove = [] }) => {
      try {
        if (!summary) return "Refused: summary is required.";
        const checked = set.map((f) => data.checkFact(f, { agent: true }));
        for (const k of remove) data.checkFact({ key: k, kind: "party", value: {}, status: "proposed" }, { agent: true });
        stage.facts.summary = stage.facts.summary ? `${stage.facts.summary}; ${summary}` : summary;
        const byKey = new Map(stage.facts.set.map((f) => [f.key, f]));
        for (const f of checked) byKey.set(f.key, f);
        stage.facts.set = [...byKey.values()];
        stage.facts.remove = [...new Set([...stage.facts.remove, ...remove])];
        return `Staged ${checked.length} fact change(s) and ${remove.length} removal(s).`;
      } catch (e) {
        return err(e);
      }
    },
  });

  return [
    campaignOverview,
    graphRead,
    graphDiff,
    documentRead,
    voiceCheck,
    openFindings,
    claimsWrite,
    findingsWrite,
    factsPropose,
  ];
}

module.exports = { toolsFor, newStage };
