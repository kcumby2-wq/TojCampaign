// One service-role Supabase client for the server (lazy). Returns false when
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY aren't set, or are set but no
// client can be made from them (a URL without https://, or in quotes).
// supabaseStatus() says which for /api/health, and the server log says why,
// once. Tests swap the client with setSupabase().
let client = null;
let status = null; // "ok" | "not_set" | "invalid", never the values themselves

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
    status = "invalid";
    console.error(`[supabase] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are set but can't be used (${e.message}). SUPABASE_URL should be https://<project-ref>.supabase.co, with no quotes.`);
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
