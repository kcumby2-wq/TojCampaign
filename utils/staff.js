// Staff access — who may use the admin side of the app.
//
// Being signed in is NOT enough. Anyone can create an account at
// /api/auth/register (the page builder needs that), and sign-up does not
// verify the email address. Staff routes — intake lists, onboarding records
// (minors' data), agent runs, client memory, pilots, accounts — need BOTH:
//
//   1. the signed-in email is on the ADMIN_EMAILS env allow-list
//        ADMIN_EMAILS="kyron@example.com,ops@example.com"   (comma-separated)
//   2. the account was not self-registered: users.role is 'staff' (set by an
//      existing staff member) or 'admin' (legacy — accounts made before this
//      change, e.g. Kyron's own).
//
// Why both: with the list alone, a stranger could sign up using a listed
// email that has no account yet. With the role alone, every pre-change
// account (all stored as 'admin', strangers included) would be staff.
//
// Secure by default: if ADMIN_EMAILS is unset or empty, every staff route
// refuses everyone (503 staff_access_not_configured) instead of falling open.
//
// The role is read from the session (set at sign-in). Sessions from before
// this change carry no role, so staff sign in once more after deploy.

// Roles stored on users.role.
const ROLES = Object.freeze({
  CREATOR: "creator", // self-registered (page builder) — the default now
  CLIENT: "client", // set by staff for a client-portal login
  STAFF: "staff", // set by staff; still needs the email on ADMIN_EMAILS
  LEGACY: "admin", // pre-change accounts; review these by hand
});
const STAFF_ROLES = new Set([ROLES.STAFF, ROLES.LEGACY]);

function staffEmails() {
  return new Set(
    String(process.env.ADMIN_EMAILS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

function sessionEmail(req) {
  const e = req.session && req.session.userEmail;
  return e ? String(e).trim().toLowerCase() : "";
}

function isStaff(req) {
  const email = sessionEmail(req);
  return (
    !!email &&
    staffEmails().has(email) &&
    STAFF_ROLES.has(req.session && req.session.userRole)
  );
}

let warnedUnset = false;

function requireStaff(req, res, next) {
  const email = sessionEmail(req);
  if (!email) return res.status(401).json({ error: "not_authenticated" });

  const list = staffEmails();
  if (list.size === 0) {
    if (!warnedUnset) {
      warnedUnset = true;
      console.warn(
        "[staff] ADMIN_EMAILS is not set — all staff routes are refusing access. " +
          "Set ADMIN_EMAILS (comma-separated) on the server."
      );
    }
    return res.status(503).json({ error: "staff_access_not_configured" });
  }

  if (!list.has(email)) return res.status(403).json({ error: "staff_only" });

  const role = req.session.userRole;
  if (!role) return res.status(401).json({ error: "sign_in_again" });
  if (!STAFF_ROLES.has(role)) return res.status(403).json({ error: "staff_only" });
  return next();
}

// Staff session OR a machine API key (external integrations / automation).
// The key is compared in constant time; an unset env var never matches.
function requireStaffOrApiKey(headerName, envName) {
  const crypto = require("crypto");
  return function (req, res, next) {
    const given = req.headers[headerName];
    const expected = process.env[envName];
    if (given && expected) {
      const a = Buffer.from(String(given));
      const b = Buffer.from(String(expected));
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        req._apiKeyAuth = true;
        return next();
      }
    }
    return requireStaff(req, res, next);
  };
}

module.exports = { requireStaff, requireStaffOrApiKey, isStaff, staffEmails, ROLES };
