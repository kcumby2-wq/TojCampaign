// Diagnostic agent pack toolset.
//
// The diagnostic motion's primary input is the discovery-call transcript,
// pasted directly into the `task`. So the toolset is intentionally lean:
//
//   - list_clients            → see who's in the pipeline (cross-client work)
//   - retrieve_client_context → ground analysis in a specific client's memory
//                               when a client_id scope is provided (their intake,
//                               prior transcripts, uploaded docs)
//
// Live tool/SaaS web research is NOT a wired tool in this stack. The
// opportunity-mapper reasons from model knowledge and names the directories
// (futurepedia.io, theresanaiforthat.com) as the human verification step.
// See skills/tool-research.md. When a web-search tool is later added, expose
// it here and add it to the orchestrator's tools[] — no other change needed.

const { listClients, retrieveClientContext } = require("../tools");

module.exports = { listClients, retrieveClientContext };
