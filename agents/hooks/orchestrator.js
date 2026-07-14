// Hooks orchestrator — thin wrapper around the shared factory.
const { createOrchestrator } = require("../orchestrator-factory");
const { listAthletes, getAthlete, retrieveClientContext } = require("./tools");

module.exports = createOrchestrator({
  namespace: "hooks",
  baseDir: __dirname,
  tools: [listAthletes, getAthlete, retrieveClientContext],
});
