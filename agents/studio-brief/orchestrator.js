// Brief Writer orchestrator — turns an idea plus references (photos, video
// stills, links, files) into one brief for the studio kit agents. Started
// from routes/studio-agents.js (POST /brief). Read-only: it can look at the
// approved kits and the web, and it hands back a brief; it changes nothing.
const { createOrchestrator } = require("../orchestrator-factory");
const { toolsFor, evalView } = require("./tools");

const stages = new WeakMap();

module.exports = createOrchestrator({
  namespace: "studio-brief",
  baseDir: __dirname,
  tools: (ctx) => {
    const scope = ctx.scope || {};
    const wrapped = {
      ...scope,
      onStage: (s) => {
        stages.set(scope, s);
        if (typeof scope.onStage === "function") scope.onStage(s);
      },
    };
    return toolsFor({ ...ctx, scope: wrapped });
  },
  evalView: (result, { scope }) =>
    evalView(result, scope ? stages.get(scope) : null, { idea: (scope && scope.idea) || "", references: (scope && scope.references) || [] }),
});
