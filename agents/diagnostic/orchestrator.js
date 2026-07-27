// Diagnostic orchestrator — thin wrapper around the shared factory.
//
// The "$999 Model": a repeatable AI-tools assessment that turns a 45-min
// discovery call into a report + an implementation offer ladder. Each role
// automates one phase of that motion. See agents/diagnostic/API.md and
// docs/TOJ-Diagnostic-Offer.md.
const { createOrchestrator } = require("../orchestrator-factory");
const { listClients, retrieveClientContext } = require("./tools");

module.exports = createOrchestrator({
  namespace: "diagnostic",
  baseDir: __dirname,
  tools: [listClients, retrieveClientContext],
});
