// Postgres access for the campaign deal graph (schema "deal", migration 015).
//
// Server-side only. Set CAMPAIGN_DATABASE_URL to the database's direct or
// pooled connection string (Supabase: Project Settings → Database). Until it
// is set, the campaign routes answer 503 campaign_db_not_configured and
// nothing else in the app changes.
//
// Every write runs in a transaction that first sets deal.actor — the staff
// email, or 'agent:<role>' for agent tools. The database gates (approvals,
// findings, members) read it; an agent is never a member, so they refuse it.

const { Pool } = require("pg");

let pool = null;

function sslFor(url) {
  if (/sslmode=disable/.test(url)) return false;
  if (/@(localhost|127\.0\.0\.1)[:/]|host=\//.test(url)) return false;
  return { rejectUnauthorized: false };
}

function getPool() {
  if (pool) return pool;
  const url = (process.env.CAMPAIGN_DATABASE_URL || "").trim();
  if (!url) return null;
  pool = new Pool({ connectionString: url, ssl: sslFor(url), max: 5 });
  pool.on("error", (e) => console.error("[campaign-db] idle client error:", e.message));
  return pool;
}

// Tests point the module at a throwaway database.
function setPool(p) {
  pool = p;
}

// Run fn(client) in one transaction with deal.actor set.
async function withActor(actor, fn) {
  const p = getPool();
  if (!p) {
    const e = new Error("campaign_db_not_configured");
    e.code = "campaign_db_not_configured";
    throw e;
  }
  const client = await p.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('deal.actor', $1, true)", [actor || ""]);
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    try {
      await client.query("rollback");
    } catch {}
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { getPool, setPool, withActor };
