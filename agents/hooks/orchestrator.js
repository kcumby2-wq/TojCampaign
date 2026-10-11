// Hooks orchestrator — thin wrapper around the shared factory.
//
// Tool scope (agents/tool-scope.js): list_athletes only in unscoped runs;
// get_athlete and client memory only for the run's own athlete/trainer.
const { createOrchestrator } = require("../orchestrator-factory");
const { roster, clientBound, clientOwned } = require("../tool-scope");
const { listAthletes, getAthlete, retrieveClientContext } = require("./tools");

module.exports = createOrchestrator({
  namespace: "hooks",
  baseDir: __dirname,
  tools: [
    roster(listAthletes),
    clientOwned(getAthlete, ({ athlete_id }, clientId) => String(athlete_id) === String(clientId)),
    clientBound(retrieveClientContext, "client_id"),
  ],
});
