// Three Directions orchestrator: a film's brief and board in (no names: cards
// by code and role), three different ways to make it out, citing the taste
// library. Started from routes/studio-words.js (POST /films/:id/directions).
// It changes nothing: the route keeps what it staged, and the producer picks.
const { createOrchestrator } = require("../orchestrator-factory");
const { toolsFor, evalView } = require("./tools");

const stages = new WeakMap();

module.exports = createOrchestrator({
  namespace: "studio-directions",
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
  evalView: (result, { scope }) => evalView(result, scope ? stages.get(scope) : null, scope || {}),
});
