// Real-Words Editor orchestrator: a film's cleared adult transcripts in;
// the strongest lines, two or three structures, cutdowns and captions out,
// every line the speaker's exact words. Started from routes/studio-words.js
// (POST /films/:id/ask-claude) only while "Claude reads transcripts" is on.
// It changes nothing: the route keeps what it staged.
const { createOrchestrator } = require("../orchestrator-factory");
const { toolsFor, evalView } = require("./tools");

const stages = new WeakMap();

module.exports = createOrchestrator({
  namespace: "studio-words",
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
