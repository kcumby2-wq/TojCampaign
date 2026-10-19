// One service-role Supabase client for the server (lazy). Returns false when
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY aren't set. Tests swap it with
// setSupabase().
let client = null;

function getSupabase() {
  if (client !== null) return client;
  const url = (process.env.SUPABASE_URL || "").trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) return (client = false);
  try {
    const { createClient } = require("@supabase/supabase-js");
    client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    return client;
  } catch {
    return (client = false);
  }
}

function setSupabase(c) {
  client = c;
}

module.exports = { getSupabase, setSupabase };
