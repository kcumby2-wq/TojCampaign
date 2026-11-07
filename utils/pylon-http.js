"use strict";
// Small pieces the Pylon routes share (routes/pylon.js, routes/pylon-outreach.js,
// routes/pylon-parent.js).

// Express 4 doesn't catch a rejected promise from an async handler, and an
// unhandled rejection stops the whole process. Every handler goes through this.
const safe = (tag) => (fn) => (req, res, next) =>
  Promise.resolve()
    .then(() => fn(req, res, next))
    .catch((e) => {
      console.error(`[${tag}] handler failed:`, e && e.message);
      if (!res.headersSent) res.status(500).json({ error: "server_error" });
    });

const bodyOf = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});

// The pages post through Vercel's rewrite, which sets X-Forwarded-For to the
// visitor's address.
const visitor = (req) =>
  String(req.headers["x-forwarded-for"] || "").split(",")[0].trim().slice(0, 100) || String((req.socket && req.socket.remoteAddress) || "unknown");

// One visitor on IPv6 is their /64, spelled out to its eight groups first, so
// "::" and leading zeros can't make one /64 look like many.
function visitorKey(v) {
  const a = String(v).toLowerCase().split("%")[0];
  if (!a.includes(":")) return a;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) return mapped[1];
  const parts = a.split("::");
  if (parts.length > 2) return a;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const groups = parts.length === 2 ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail] : head;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return a;
  return groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":") + "::/64";
}

// max hits per key per window. limited(key) says whether this one is over.
// Bounded: expired windows go first, then the oldest past `tracked` keys.
function windowLimiter(max, windowMs, tracked = 5000) {
  const hits = new Map();
  function limited(key, now = Date.now()) {
    const h = hits.get(key);
    if (h && now - h.start <= windowMs) {
      h.n += 1;
      return h.n > max;
    }
    if (h) hits.delete(key);
    hits.set(key, { start: now, n: 1 });
    for (const [k, v] of hits) {
      if (now - v.start <= windowMs && hits.size <= tracked) break;
      hits.delete(k);
    }
    return false;
  }
  limited.reset = () => hits.clear();
  return limited;
}

// The address the immediate caller connected from, as Render's proxy saw it
// (server.js trusts that one hop). Through Vercel's rewrite it's Vercel's;
// straight at Render, it's the caller's own, whatever X-Forwarded-For says.
const peer = (req) => String(req.ip || (req.socket && req.socket.remoteAddress) || "unknown");

// Where the pages live. A browser names the page a post came from (Origin);
// a post from anywhere else is another site's, and is refused. No Origin: not
// a browser's post, so not another site acting through a visitor.
const PAGE_ORIGINS = ["https://tojcampaign.com", "https://www.tojcampaign.com"];
function originOk(req) {
  const origin = String(req.headers.origin || "");
  if (!origin) return true;
  let o;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  const allowed = new Set(PAGE_ORIGINS);
  const base = String(process.env.PYLON_SITE_BASE || "").trim();
  if (base) {
    try {
      allowed.add(new URL(base).origin);
    } catch {}
  }
  if (allowed.has(o.origin)) return true;
  // The same host the request came to (the app's own pages, or a local copy).
  const host = String(req.headers.host || "").toLowerCase();
  return !!host && o.host.toLowerCase() === host;
}

module.exports = { safe, bodyOf, visitor, visitorKey, windowLimiter, peer, originOk };
