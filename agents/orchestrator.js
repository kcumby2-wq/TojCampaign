// TOJ orchestrator — thin wrapper around the shared factory.
//
// Tool scope (agents/tool-scope.js): list_clients only in unscoped runs;
// Foundation Score and client memory only for the run's own client.
const { createOrchestrator } = require("./orchestrator-factory");
const { roster, clientBound, clientOwned } = require("./tool-scope");
const {
  listClients,
  getFoundationScore,
  retrieveClientContext,
  foundationScoreBelongsTo,
} = require("./tools");

module.exports = createOrchestrator({
  namespace: "toj",
  baseDir: __dirname,
  tools: [
    roster(listClients),
    clientOwned(getFoundationScore, foundationScoreBelongsTo),
    clientBound(retrieveClientContext, "client_id"),
  ],
});
