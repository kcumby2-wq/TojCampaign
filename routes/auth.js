// Auth routes — Supabase-first with JSON fallback.
//
// Users used to live in db/users.json, which is ephemeral on Render's
// disk (wiped on every redeploy). This version stores users in Supabase
// so sessions survive deploys. Local dev without Supabase creds still
// works via the JSON fallback.

const express = require("express");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const router = express.Router();

const { ROLES } = require("../utils/staff");

const USERS_FILE = path.join(__dirname, "..", "db", "users.json");

// Start a fresh session id at sign-in (no session fixation), then record who
// signed in and their stored role. Staff access is NOT decided here — see
// utils/staff.js (ADMIN_EMAILS allow-list + a role that was not self-registered).
// Resolves true on success, false if the session store failed (Express 4
// does not catch rejected promises in handlers, so this never rejects).
function signIn(req, email, role) {
  return new Promise((resolve) => {
    req.session.regenerate((err) => {
      if (err) {
        console.error("[auth] session regenerate failed:", err.message);
        return resolve(false);
      }
      req.session.userEmail = email;
      req.session.userRole = role;
      req.session.save((err2) => {
        if (err2) console.error("[auth] session save failed:", err2.message);
        resolve(!err2);
      });
    });
  });
}

// ---- Supabase (lazy) ----
let supabase = null;
function getSupabase() {
  if (supabase !== null) return supabase;
  const url = (process.env.SUPABASE_URL || "").trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) return (supabase = false);
  try {
    const { createClient } = require("@supabase/supabase-js");
    supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    console.log("[auth] using Supabase backend");
    return supabase;
  } catch (e) {
    console.error("[auth] Supabase init failed:", e.message);
    return (supabase = false);
  }
}

// ---- JSON fallback helpers ----
function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch {
    return [];
  }
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
function isValidEmail(s) {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

// POST /api/auth/register
// Open on purpose (the page builder signs creators up here), so a new account
// is a 'creator' — never staff, never a client-portal login.
router.post("/register", async (req, res) => {
  const email = (req.body?.email || "").toString().trim().toLowerCase();
  const password = req.body?.password || "";
  if (!isValidEmail(email))
    return res.status(400).json({ error: "invalid_email" });
  if (password.length < 6)
    return res.status(400).json({ error: "password_too_short" });

  const hash = await bcrypt.hash(password, 10);
  const sb = getSupabase();

  if (sb) {
    const { data, error } = await sb
      .from("users")
      .insert({ email, hash, role: ROLES.CREATOR })
      .select("email,role")
      .single();
    if (error) {
      if (error.code === "23505")
        return res.status(409).json({ error: "email_already_registered" });
      console.error("[auth] register error:", error);
      return res.status(500).json({ error: "storage_error" });
    }
    if (!(await signIn(req, data.email, data.role || ROLES.CREATOR)))
      return res.status(500).json({ error: "session_error" });
    return res.json({ success: true, email: data.email });
  }

  // ---- JSON fallback ----
  const users = loadUsers();
  if (users.find((u) => u.email.toLowerCase() === email))
    return res.status(409).json({ error: "email_already_registered" });
  users.push({ email, hash, role: ROLES.CREATOR, createdAt: new Date().toISOString() });
  saveUsers(users);
  if (!(await signIn(req, email, ROLES.CREATOR)))
    return res.status(500).json({ error: "session_error" });
  res.json({ success: true, email });
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const email = (req.body?.email || "").toString().trim().toLowerCase();
  const password = req.body?.password || "";
  if (!email || !password)
    return res.status(400).json({ error: "missing_credentials" });

  const sb = getSupabase();
  let user = null;

  if (sb) {
    const { data, error } = await sb
      .from("users")
      .select("email,hash,role")
      .eq("email", email)
      .maybeSingle();
    if (error) {
      console.error("[auth] login lookup error:", error);
      return res.status(500).json({ error: "storage_error" });
    }
    user = data;
  } else {
    const users = loadUsers();
    user = users.find((u) => u.email.toLowerCase() === email) || null;
  }

  if (!user) return res.status(401).json({ error: "invalid_credentials" });
  const ok = await bcrypt.compare(password, user.hash);
  if (!ok) return res.status(401).json({ error: "invalid_credentials" });

  // Accounts made before roles were set have no role in the JSON fallback;
  // the Supabase column defaulted to 'admin'. Both are treated as legacy.
  if (!(await signIn(req, user.email, user.role || ROLES.LEGACY)))
    return res.status(500).json({ error: "session_error" });
  res.json({ success: true, email: user.email });
});

// POST /api/auth/logout
router.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

module.exports = router;
