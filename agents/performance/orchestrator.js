// Performance orchestrator — thin wrapper around the shared factory.
//
// The runtime layer for performance-os (github.com/kcumby2-wq/performance-os)
// — the recruiting-fog-reducer product line. Each role automates one phase of
// the wearable-data → athlete-facing recap → coach-facing scout report motion.
// See agents/performance/API.md.
const { createOrchestrator } = require("../orchestrator-factory");
const { listClients, retrieveClientContext } = require("./tools");

module.exports = createOrchestrator({
  namespace: "performance",
  baseDir: __dirname,
  tools: [listClients, retrieveClientContext],
});
