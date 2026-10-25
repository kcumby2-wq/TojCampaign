// One service-role Supabase client for the server (lazy). Returns false when
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY aren't set, or when no client can
// be made: an address without https:// or in quotes, or Node.js older than 22
// (supabase-js needs its built-in WebSocket; that took the live app down on
// Oct 24, 2026). supabaseStatus() says which for /api/health, and the server
// log says why, once. Tests swap the client with setSupabase().
let client = null;
let status = null; // "ok" | "not_set" | "error", never the values themselves

function getSupabase() {
  if (client !== null) return client;
  const url = (process.env.SUPABASE_URL || "").trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) {
    status = "not_set";
    return (client = false);
  }
  try {
    const { createClient } = require("@supabase/supabase-js");
    client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    status = "ok";
    return client;
  } catch (e) {
    // Everything that reads the database, the Pylon stop pages included,
    // acts as if it were empty until this is fixed, so say it where it's seen.
    status = "error";
    const hint = /supabaseUrl/i.test(e.message)
      ? " SUPABASE_URL should be https://<project-ref>.supabase.co, with no quotes."
      : /WebSocket/i.test(e.message)
        ? " supabase-js needs Node.js 22 or later: set NODE_VERSION to 22 on Render."
        : "";
    console.error(`[supabase] Can't create the Supabase client (${e.message}).${hint}`);
    return (client = false);
  }
}

function supabaseStatus() {
  getSupabase();
  return status || (client ? "ok" : "not_set");
}

function setSupabase(c) {
  client = c;
  status = c ? "ok" : null;
}

module.exports = { getSupabase, setSupabase, supabaseStatus };
