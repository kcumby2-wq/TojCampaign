// Agent tool scoping — a run reads only the client it was scoped to, and a
// role gets only the tools it lists. No database, no network, no API key.
//
//   node --test tests/agent-tool-scope.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { roster, clientBound, clientOwned, resolveTools } = require("../agents/tool-scope");
const { createOrchestrator } = require("../agents/orchestrator-factory");
const { checkClientScope } = require("../utils/agent-client-scope");

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

function fakeTool(name, props = {}, required = []) {
  const calls = [];
  return {
    calls,
    tool: {
      type: "custom",
      name,
      description: name,
      input_schema: { type: "object", properties: props, required },
      run: async (input) => {
        calls.push(input);
        return "ok";
      },
      parse: (x) => x,
    },
  };
}

test("unscoped run: roster tools only, no per-client reads", () => {
  const list = fakeTool("list_clients");
  const mem = fakeTool("retrieve_client_context", { client_id: { type: "string" }, query: { type: "string" } }, ["client_id", "query"]);
  const rec = fakeTool("get_record", { id: { type: "string" } });
  const plain = fakeTool("plain_tool");
  const tools = resolveTools(
    [roster(list.tool), clientBound(mem.tool), clientOwned(rec.tool, () => true), plain.tool],
    { client_id: null }
  );
  assert.deepEqual(tools.map((t) => t.name), ["list_clients", "plain_tool"]);
});

test("scoped run: no roster; client_id is removed from the schema and forced to the run's client", async () => {
  const list = fakeTool("list_clients");
  const mem = fakeTool("retrieve_client_context", { client_id: { type: "string" }, query: { type: "string" } }, ["client_id", "query"]);
  const tools = resolveTools([roster(list.tool), clientBound(mem.tool)], { client_id: A });
  assert.deepEqual(tools.map((t) => t.name), ["retrieve_client_context"]);
  const t = tools[0];
  assert.ok(!("client_id" in t.input_schema.properties), "model can't see client_id");
  assert.deepEqual(t.input_schema.required, ["query"]);
  // Even if the model sends another client's id, the run's client wins.
  await t.run({ client_id: B, query: "hello" });
  assert.equal(mem.calls[0].client_id, A);
  // The serialized tool sent to the API carries no scoping metadata.
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(t))).sort(), ["description", "input_schema", "name", "type"]);
});

test("scoped run: a record owned by another client is refused", async () => {
  const rec = fakeTool("get_athlete", { athlete_id: { type: "string" } });
  const [t] = resolveTools([clientOwned(rec.tool, ({ athlete_id }, c) => athlete_id === c)], { client_id: A });
  assert.match(await t.run({ athlete_id: B }), /Refused/);
  assert.equal(rec.calls.length, 0);
  assert.equal(await t.run({ athlete_id: A }), "ok");
  const [t2] = resolveTools([clientOwned(rec.tool, () => { throw new Error("db down"); })], { client_id: A });
  assert.match(await t2.run({ athlete_id: A }), /could not check/);
});

test("a cross-roster role reads unbound in an unscoped run, and bound once scoped", async () => {
  const list = fakeTool("list_athletes");
  const mem = fakeTool("retrieve_client_context", { client_id: { type: "string" }, query: { type: "string" } }, ["client_id", "query"]);
  const entries = [roster(list.tool), clientBound(mem.tool)];
  const open = resolveTools(entries, { client_id: null, cross_client: true });
  assert.deepEqual(open.map((t) => t.name), ["list_athletes", "retrieve_client_context"]);
  assert.ok("client_id" in open[1].input_schema.properties);
  const scoped = resolveTools(entries, { client_id: A, cross_client: true });
  assert.deepEqual(scoped.map((t) => t.name), ["retrieve_client_context"]);
  await scoped[0].run({ client_id: B, query: "q" });
  assert.equal(mem.calls[0].client_id, A, "scope still wins for a cross-roster role");
});

test("a role that lists tools gets only those", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pack-"));
  fs.mkdirSync(path.join(dir, "roles"));
  fs.writeFileSync(path.join(dir, "roles", "narrow.js"),
    `module.exports = { id: "narrow", label: "N", skills: [], persona: "p", tools: ["plain_tool"] };`);
  fs.writeFileSync(path.join(dir, "roles", "wide.js"),
    `module.exports = { id: "wide", label: "W", skills: [], persona: "p" };`);
  const list = fakeTool("list_clients");
  const plain = fakeTool("plain_tool");
  const o = createOrchestrator({ namespace: "t", baseDir: dir, tools: [roster(list.tool), plain.tool] });
  assert.deepEqual(o.toolsForRun("narrow").map((t) => t.name), ["plain_tool"]);
  assert.deepEqual(o.toolsForRun("wide").map((t) => t.name).sort(), ["list_clients", "plain_tool"]);
  assert.throws(() => o.toolsForRun("nope"), /unknown_role/);
});

test("the four existing packs follow the scope rules", () => {
  const packs = {
    toj: require("../agents/orchestrator"),
    hooks: require("../agents/hooks/orchestrator"),
    diagnostic: require("../agents/diagnostic/orchestrator"),
    performance: require("../agents/performance/orchestrator"),
  };
  for (const [ns, o] of Object.entries(packs)) {
    for (const role of Object.keys(o.ROLES)) {
      const unscoped = o.toolsForRun(role).map((t) => t.name);
      if (o.ROLES[role].cross_client) {
        // Cross-roster report roles may read anyone they list — and only those roles.
        assert.deepEqual(`${ns}/${role}`, "hooks/roster-pulse");
      } else {
        assert.ok(!unscoped.includes("retrieve_client_context"), `${ns}/${role}: unscoped run can read client memory`);
      }
      const scoped = o.toolsForRun(role, { client_id: A });
      assert.ok(!scoped.some((t) => /^list_/.test(t.name)), `${ns}/${role}: scoped run can list everyone`);
      for (const t of scoped) {
        assert.ok(!("client_id" in (t.input_schema.properties || {})), `${ns}/${role}: ${t.name} lets the model pick a client`);
      }
    }
  }
});

test("campaign pack: tools need a campaign scope, and each role gets its own list", () => {
  const o = require("../agents/campaign/orchestrator");
  assert.throws(() => o.toolsForRun("consistency"), /campaign scope/);
  const scope = { tenant_id: A, campaign_id: B };
  const consistency = o.toolsForRun("consistency", { scope }).map((t) => t.name);
  const intake = o.toolsForRun("intake", { scope }).map((t) => t.name);
  assert.ok(consistency.includes("findings_write") && !consistency.includes("facts_propose"));
  assert.ok(intake.includes("facts_propose") && !intake.includes("findings_write"));
  for (const t of o.toolsForRun("consistency", { scope }).concat(o.toolsForRun("intake", { scope }))) {
    const props = Object.keys(t.input_schema.properties || {});
    assert.ok(!props.includes("tenant_id") && !props.includes("campaign_id"), `${t.name} lets the model pick a campaign`);
  }
  assert.ok(!consistency.concat(intake).some((n) => /approve/.test(n)), "no agent tool approves anything");
});

test("checkClientScope: none, malformed, unknown, real", async () => {
  const sb = (row, error = null) => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error }) }) }) }),
  });
  assert.deepEqual(await checkClientScope(sb(null), null), { ok: true, client_id: null });
  assert.equal((await checkClientScope(sb(null), "drop table")).error, "invalid_client_id");
  assert.equal((await checkClientScope(sb(null), A)).error, "unknown_client");
  assert.equal((await checkClientScope(sb(null, { message: "x" }), A)).status, 500);
  assert.deepEqual(await checkClientScope(sb({ id: A }), A), { ok: true, client_id: A });
});
