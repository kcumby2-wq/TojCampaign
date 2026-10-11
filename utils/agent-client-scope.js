// Check the client a staff member scoped an agent run to, before the run
// starts. A run scoped to a client can read only that client's data (see
// agents/tool-scope.js), so the id has to be a real client record — not a
// typo, and not something that silently becomes "no client".
//
//   const scope = await checkClientScope(sb, client_id);
//   if (!scope.ok) return res.status(scope.status).json({ error: scope.error });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function checkClientScope(sb, clientId) {
  if (clientId === null || clientId === undefined || clientId === "")
    return { ok: true, client_id: null };
  if (typeof clientId !== "string" || !UUID_RE.test(clientId))
    return { ok: false, status: 400, error: "invalid_client_id" };

  const { data, error } = await sb.from("clients").select("id").eq("id", clientId).maybeSingle();
  if (error) return { ok: false, status: 500, error: "storage_error" };
  if (!data) return { ok: false, status: 400, error: "unknown_client" };
  return { ok: true, client_id: data.id };
}

module.exports = { checkClientScope };
