// Diagnostic orchestrator — thin wrapper around the shared factory.
//
// The "$999 Model": a repeatable AI-tools assessment that turns a 45-min
// discovery call into a report + an implementation offer ladder. Each role
// automates one phase of that motion. See agents/diagnostic/API.md and
// docs/TOJ-Diagnostic-Offer.md.
const { createOrchestrator } = require("../orchestrator-factory");
const { roster, clientBound } = require("../tool-scope");
const { listClients, retrieveClientContext } = require("./tools");

module.exports = createOrchestrator({
  namespace: "diagnostic",
  baseDir: __dirname,
  // list_clients only in unscoped runs; client memory only for the run's client.
  tools: [roster(listClients), clientBound(retrieveClientContext, "client_id")],
});
