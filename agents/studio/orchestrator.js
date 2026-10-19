// Studio orchestrator — agents that build and refresh Milanote kits
// (production playbooks laid out as Milanote columns and cards).
//
// Tools are built per run attempt and stage every write in memory
// (./tools.js). The judge scores the staged kit, not just the agent's
// closing text (evalView). Runs are started from routes/studio-agents.js,
// which saves the staged kit as a DRAFT; only a person approves a draft.
const { createOrchestrator } = require("../orchestrator-factory");
const { toolsFor, evalView } = require("./tools");

// The latest stage per run scope, so the judge can see what the attempt built.
const stages = new WeakMap();

module.exports = createOrchestrator({
  namespace: "studio",
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
    evalView(result, scope ? stages.get(scope) : null, { sourceExcerpt: (scope && scope.source_excerpt) || "" }),
});
