// Performance agent pack toolset.
//
// The performance motion's inputs are session data (from PlayerData exports
// or the future Supabase performance schema) and athlete context. Lean toolset
// mirrors the diagnostic pack.
//
//   - list_clients            → cross-athlete cohort work
//   - retrieve_client_context → ground scout-report claims in a specific
//                               athlete's stored memory (prior sessions,
//                               film notes, Prospect Edge grade if Hooks
//                               client)
//
// Live PlayerData API pull is NOT wired here. Session data is expected in the
// task input for now (paste raw PD export JSON, or a structured session_metrics
// blob). When the Supabase schema from performance-os/product/data-model.md
// lands, add get_session_metrics + list_athlete_sessions tools and register
// them in the orchestrator's tools[] — no other change needed.

const { listClients, retrieveClientContext } = require("../tools");

module.exports = { listClients, retrieveClientContext };
