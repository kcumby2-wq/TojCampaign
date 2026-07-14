// TOJ orchestrator — thin wrapper around the shared factory.
const { createOrchestrator } = require("./orchestrator-factory");
const { listClients, getFoundationScore, retrieveClientContext } = require("./tools");

module.exports = createOrchestrator({
  namespace: "toj",
  baseDir: __dirname,
  tools: [listClients, getFoundationScore, retrieveClientContext],
});
