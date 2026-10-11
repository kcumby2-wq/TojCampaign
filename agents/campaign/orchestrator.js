// Campaign orchestrator — agents that keep a campaign's documents in line
// with its deal graph (migration 015, schema "deal").
//
// Tools are built per run and bound to one campaign (./tools.js); each role
// lists exactly the tools it may use. Runs are started from routes/campaign.js.
const { createOrchestrator } = require("../orchestrator-factory");
const { toolsFor } = require("./tools");

module.exports = createOrchestrator({
  namespace: "campaign",
  baseDir: __dirname,
  tools: (ctx) => toolsFor(ctx),
});
