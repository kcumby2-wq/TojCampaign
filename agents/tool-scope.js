// Tool scoping — which tools a run gets, and whose data they can touch.
//
// A run is either scoped to one client (the client the staff member picked)
// or unscoped (cross-client work like "who on the waitlist should I call?").
// The model never chooses which client a tool reads; the run does.
//
// Wrap each tool in a pack's orchestrator with one of these:
//
//   roster(tool)                   cross-client listing. Unscoped runs only —
//                                  a run about one client doesn't need (and
//                                  shouldn't be able to dump) everyone else.
//   clientBound(tool, "client_id") reads one client's data. Scoped runs only;
//                                  the argument is removed from the schema the
//                                  model sees and filled from the run.
//   clientOwned(tool, owns)        reads a record by id. Scoped runs only; the
//                                  record must belong to the run's client:
//                                  owns(input, clientId) → true/false.
//
// A plain tool (no wrapper) is offered to every run, as before.
//
// Cross-roster roles: a role marked `cross_client: true` (e.g. Hooks Roster
// Pulse, a weekly report across every athlete) gets the client tools in an
// UNSCOPED run too, unbound, so it can read the people it lists. Only roles
// whose whole job is a cross-client report for staff should carry the flag;
// anything written to or about one client runs scoped.
//
// Tool objects go to the Anthropic API as-is (functions are dropped when they
// are serialized), so scoping metadata lives on a wrapper object, never on
// the tool itself.

const KIND = Symbol("toolScope");

function roster(tool) {
  return { [KIND]: "roster", tool };
}

function clientBound(tool, arg = "client_id") {
  return { [KIND]: "bound", tool, arg };
}

function clientOwned(tool, owns) {
  if (typeof owns !== "function") throw new Error("clientOwned needs an owns(input, clientId) function");
  return { [KIND]: "owned", tool, owns };
}

function toolName(entry) {
  return entry && entry[KIND] ? entry.tool.name : entry && entry.name;
}

function withoutArg(schema, arg) {
  const properties = { ...(schema.properties || {}) };
  delete properties[arg];
  const out = { ...schema, properties };
  if (Array.isArray(schema.required)) out.required = schema.required.filter((r) => r !== arg);
  return out;
}

// Resolve a pack's tool list for one run.
function resolveTools(entries, { client_id = null, cross_client = false } = {}) {
  const scoped = !!client_id;
  const out = [];
  for (const entry of entries) {
    const kind = entry && entry[KIND];
    if (!kind) {
      out.push(entry);
      continue;
    }
    const t = entry.tool;
    if (kind === "roster") {
      if (!scoped) out.push(t);
      continue;
    }
    if (!scoped) {
      if (cross_client) out.push(t); // cross-roster role: unbound
      continue; // otherwise client tools need a client
    }
    if (kind === "bound") {
      out.push({
        ...t,
        input_schema: withoutArg(t.input_schema, entry.arg),
        run: (input, ...rest) => t.run({ ...(input || {}), [entry.arg]: client_id }, ...rest),
      });
    } else if (kind === "owned") {
      out.push({
        ...t,
        run: async (input, ...rest) => {
          let ok = false;
          try {
            ok = await entry.owns(input || {}, client_id);
          } catch (e) {
            return `Error: could not check that this record belongs to the client in scope.`;
          }
          if (!ok) return `Refused: that record does not belong to the client this run is scoped to.`;
          return t.run(input, ...rest);
        },
      });
    }
  }
  return out;
}

module.exports = { roster, clientBound, clientOwned, resolveTools, toolName };
