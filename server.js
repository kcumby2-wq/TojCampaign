const express = require("express");
const session = require("express-session");
const path = require("path");

// Initialize report schedulers
const { initializeSchedulers } = require("./utils/reportScheduler");

// Boot-time env diagnostic — logs which critical vars are present without
// exposing values. Read this on Render at deploy time to debug fallback bugs.
(function envDiag() {
  const check = (k) => {
    const v = process.env[k];
    if (!v) return `${k}=MISSING`;
    return `${k}=SET(len=${v.length})`;
  };
  console.log(
    "[env]",
    [
      check("SUPABASE_URL"),
      check("SUPABASE_SERVICE_ROLE_KEY"),
      check("VOYAGE_API_KEY"),
      check("ANTHROPIC_API_KEY"),
      check("BASE_URL"),
      check("SESSION_SECRET"),
    ].join(" · ")
  );
})();

const app = express();
// Render (and Vercel's rewrite before it) proxies every request: trust one
// hop so req.secure reflects HTTPS and the session cookie can be Secure.
const { sessionCookie, TRUST_PROXY_HOPS } = require("./utils/session-cookie");
app.set("trust proxy", TRUST_PROXY_HOPS);
const PORT = process.env.PORT || 3000;

// The Creator Club's Stripe webhook needs the exact bytes Stripe signed.
app.use(
  express.json({
    limit: "5mb",
    verify: (req, _res, buf) => {
      if (req.originalUrl && req.originalUrl.startsWith("/api/creators/stripe/webhook")) req.rawBody = Buffer.from(buf);
    },
  })
);
app.use(express.urlencoded({ extended: true, limit: "5mb" }));

// CORS allowlist. In production the marketing site (tojcampaign.com on Vercel)
// reaches this backend via a Vercel rewrite of /api/* → the Render URL, so
// requests are same-origin and don't need CORS. This allowlist is a safety net
// for any direct cross-origin call (e.g. hitting the Render URL from a browser).
const CORS_ALLOWED_ORIGINS = new Set([
  "https://tojcampaign.com",
  "https://www.tojcampaign.com",
  "http://localhost:3000",
  "http://localhost:5173",
  // Sibling intake front-ends that POST onboarding intakes to this backend.
  // (Each can alternatively proxy /api/* via its own vercel.json for same-
  // origin, no-CORS calls — see routes/onboarding.js header.)
  "https://verified-season.vercel.app",
  "https://subject-media-ops-xow7.vercel.app",
  // Extend without a code change: ONBOARDING_CORS_ORIGINS="https://a,https://b"
  ...String(process.env.ONBOARDING_CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && CORS_ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "600");
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// Session store. Postgres-backed (connect-pg-simple) when DATABASE_URL is set —
// sessions then survive Render restarts/redeploys and scale past one process.
// Falls back to the in-memory store (dev / not-yet-configured) with a warning.
let sessionStoreKind = "memory";
const sessionOpts = {
  secret: process.env.SESSION_SECRET || "toj-dev-secret-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: sessionCookie(), // 1 week, httpOnly, Secure over HTTPS (utils/session-cookie.js)
};
if (process.env.DATABASE_URL) {
  try {
    const PgStore = require("connect-pg-simple")(session);
    const { Pool } = require("pg");
    sessionOpts.store = new PgStore({
      pool: new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
      }),
      createTableIfMissing: true,
    });
    sessionStoreKind = "postgres";
    console.log("[session] Postgres-backed store active (survives redeploys)");
  } catch (e) {
    console.warn("[session] DATABASE_URL set but pg store failed — MemoryStore:", e.message);
  }
} else if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  // No DATABASE_URL: keep sessions in Supabase's public.session table through
  // the service-role client, so sign-ins still survive restarts and deploys.
  try {
    const { createClient } = require("@supabase/supabase-js");
    const { SupabaseSessionStore } = require("./utils/supabase-session-store");
    sessionOpts.store = new SupabaseSessionStore({
      client: createClient(process.env.SUPABASE_URL.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY.trim(), {
        auth: { persistSession: false, autoRefreshToken: false },
      }),
    });
    sessionStoreKind = "supabase";
    console.log("[session] Supabase-backed store active (survives redeploys)");
  } catch (e) {
    console.warn("[session] Supabase store failed — MemoryStore:", e.message);
  }
} else {
  console.warn("[session] no DATABASE_URL — MemoryStore (sessions reset on restart). Set DATABASE_URL to persist logins.");
}
app.use(session(sessionOpts));

// Auth gate for API routes (except /auth)
function requireAuth(req, res, next) {
  if (req.session && req.session.userEmail) return next();
  return res.status(401).json({ error: "Not authenticated" });
}

// Public: login page + auth routes
app.use("/api/auth", require("./routes/auth"));

// Public: landing page rendering and analytics tracking
app.use("/api/analytics", require("./routes/analytics"));
app.use("/api/email", require("./routes/email"));
app.use("/api/intake", require("./routes/intake"));
app.use("/api/onboarding", require("./routes/onboarding"));
app.use("/api/waitlist", require("./routes/waitlist"));
app.use("/api/admin", require("./routes/admin"));
app.use("/api/client", require("./routes/client"));
app.use("/api", require("./routes/phase1"));

// 301 redirects: legacy avenue pages → v2 verticals (see archive/README.md)
const legacyRedirects = {
  "/sports.html": "/authority.html",
  "/smallbusiness.html": "/personal-brand.html",
  "/bigbusiness.html": "/nonprofit.html",
  "/advisory.html": "/personal-brand.html",
  "/instructors.html": "/how-we-work.html",
};
Object.entries(legacyRedirects).forEach(([from, to]) => {
  app.get(from, (req, res) => res.redirect(301, to));
});
// /intake.html is the campaign intake again (it used to redirect to the
// Foundation Score, which stays at /foundation-score.html). Short link: /intake.
app.get(["/intake", "/intake/"], (_req, res) => res.redirect(302, "/intake.html"));

// Serve static frontend
app.use(express.static(path.join(__dirname, "public")));

// Protected API routes
app.use("/api/utm", requireAuth, require("./routes/utm"));
app.use("/api/qr", requireAuth, require("./routes/qr"));
app.use("/api/csv", requireAuth, require("./routes/csv"));
app.use("/api/templates", requireAuth, require("./routes/templates"));
app.use("/api/contacts", requireAuth, require("./routes/contacts"));
app.use("/api/pages", requireAuth, require("./routes/pages"));
app.use("/api/billing", requireAuth, require("./routes/billing"));
app.use("/api/reports", requireAuth, require("./routes/reports"));
app.use("/api/marketplace", requireAuth, require("./routes/marketplace"));
// Client memory (retrieve / ingest / backfill) — staff only, not just signed in.
app.use("/api/rag", require("./utils/staff").requireStaff, require("./routes/rag"));
// /api/agents/roles and /skills are public metadata; only /run is auth-gated
// (enforced inside the route file so the roles picker renders pre-login).
app.use("/api/agents", require("./routes/agents"));
app.use("/api/hooks-agents", require("./routes/hooks-agents"));
app.use("/api/diagnostic-agents", require("./routes/diagnostic-agents"));
app.use("/api/performance-agents", require("./routes/performance-agents"));
// Studio agents — build and refresh Milanote kits. Runs save drafts only;
// a staff member approves (agents/studio/API.md).
app.use("/api/studio-agents", require("./routes/studio-agents"));
// The Creator Club (phase 1): the Creators tool, checkout, the Stripe webhook,
// and the creators' public pages at /c/<slug>.
app.use("/api/creators", require("./routes/creators"));
app.use("/c", require("./routes/creators").pageRouter);
app.use("/api/os", require("./routes/os"));
// Ground Floor Sports · Pylon events: events, crews, roster consent flags,
// the upload log, deliverables, SportsClippers listings, takedowns (024),
// and the public stop pages its QR codes open at /e/<event code> (025).
app.use("/api/gfs", require("./routes/gfs"));
app.use("/e", require("./routes/gfs-page"));
// The team: invites, roles, activity (utils/team.js). Owner-only consoles keep requireStaff.
app.use("/api/team", require("./routes/team"));
// Web push for the TOJ app (utils/push.js).
app.use("/api/push", require("./routes/push"));
app.get(["/studio", "/studio/"], (_req, res) => res.redirect(302, "/app/#studio"));
// Campaign deal graph + campaign agents — staff only; membership checked per
// campaign inside the route. Needs CAMPAIGN_DATABASE_URL (503 until set).
app.use("/api/campaign", require("./utils/staff").requireStaff, require("./routes/campaign"));
// Pylon route needs a Postgres `db` module (it calls db.query(...) throughout).
// That module was never wired, so requiring it crashes boot. Mount defensively:
// if ../db is missing, skip the route with a warning instead of taking the whole
// server down. It auto-enables the day a real db module exists.
try {
  app.use("/api/pylon", require("./routes/pylon"));
} catch (e) {
  console.warn("[pylon] route not mounted — missing ../db module:", e.message);
}
// Public, token-gated parent approval of recruiting outreach (migration 013).
// Same db dependency as /api/pylon, so it is mounted the same defensive way.
try {
  app.use("/api/pylon-parent", require("./routes/pylon-parent"));
} catch (e) {
  console.warn("[pylon-parent] route not mounted — missing ../db module:", e.message);
}

// Pylon × TOJ · pre/during/post-event sales sequence cron
// Toggle via env: PYLON_CRON_ENABLED=true
if (process.env.PYLON_CRON_ENABLED === "true") {
  require("./utils/pylon-sequence-cron").start();
}

// Public health signal — powers the live status dot on the Command Center.
// Reports which storage/AI backends are actually wired (no secrets leaked).
app.get("/api/health", (req, res) => {
  const supa = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  res.json({
    ok: true,
    backend: supa ? "supabase" : "json",
    // "ok", "not_set", or "invalid": set, but no client can be made from it.
    supabase: require("./utils/supabase").supabaseStatus(),
    voyage: !!process.env.VOYAGE_API_KEY,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    sessionStore: sessionStoreKind,
    ts: new Date().toISOString(),
  });
});

// Small helper to check auth from frontend
app.get("/api/me", async (req, res) => {
  if (req.session && req.session.userEmail) {
    let team = null;
    try {
      const a = await require("./utils/team").accessFor(req);
      if (a) team = { role: a.role, tools: a.tools, regions: a.regions || [], owner: a.owner, name: a.name };
    } catch {}
    return res.json({
      authenticated: true,
      email: req.session.userEmail,
      staff: require("./utils/staff").isStaff(req),
      team,
    });
  }
  res.json({ authenticated: false });
});

// Public landing page renderer
app.get("/pages/:slug", (req, res) => {
  const fs = require("fs");
  const pagesFile = path.join(__dirname, "db", "landing_pages.json");
  
  try {
    const pages = JSON.parse(fs.readFileSync(pagesFile, "utf8"));
    const page = pages.find((p) => p.slug === req.params.slug);
    
    if (!page) {
      return res.status(404).send("<h1>Landing page not found</h1>");
    }

    const templatesFile = path.join(__dirname, "db", "templates_data.json");
    const templates = JSON.parse(fs.readFileSync(templatesFile, "utf8"));
    const template = templates.find((t) => t.id === page.templateId);

    if (!template) {
      return res.status(404).send("<h1>Template not found</h1>");
    }

    // Render the landing page with customizations
    let html = template.html;
    if (page.customizations.featuresList) {
      const features = page.customizations.featuresList
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((item) => `<li>${item}</li>`)
        .join("");
      html = html.replace(/{{featuresList}}/g, features);
    }
    if (page.customizations.linksGrid) {
      let linksHtml = "";
      try {
        const links = JSON.parse(page.customizations.linksGrid);
        linksHtml = links
          .map(
            (l) =>
              `<a class='link-card' href='${l.url}' target='_blank' rel='noopener'><h3>${l.title}</h3><p>${l.description || ""}</p></a>`
          )
          .join("");
      } catch {
        linksHtml = "";
      }
      html = html.replace(/{{linksGrid}}/g, linksHtml);
    }
    Object.entries(page.customizations).forEach(([key, value]) => {
      html = html.replace(new RegExp(`{{${key}}}`, "g"), value);
    });

    const fullPage = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${page.pageTitle}</title>
        <style>${template.css}</style>
      </head>
      <body>
        ${html}
        <section style="max-width:760px;margin:24px auto;padding:20px;background:#fff;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.08);font-family:system-ui,sans-serif;">
          <h3 style="margin:0 0 8px 0;">Join updates</h3>
          <p style="margin:0 0 12px 0;color:#6b7280;">Get creator updates and offers by email.</p>
          <form id="emailCaptureForm" style="display:flex;gap:8px;flex-wrap:wrap;">
            <input id="captureName" type="text" placeholder="Your name" style="flex:1;min-width:140px;padding:10px;border:1px solid #d1d5db;border-radius:8px;">
            <input id="captureEmail" type="email" required placeholder="you@example.com" style="flex:2;min-width:180px;padding:10px;border:1px solid #d1d5db;border-radius:8px;">
            <button type="submit" style="padding:10px 16px;border:0;border-radius:8px;background:#111827;color:#fff;font-weight:600;">Subscribe</button>
          </form>
          <p id="emailCaptureMsg" style="margin-top:10px;font-size:13px;color:#2563eb;"></p>
        </section>
        <script>
          // Track page view
          fetch("/api/analytics/track", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              pageId: "${page.id}",
              utm_source: new URLSearchParams(window.location.search).get("utm_source"),
              utm_medium: new URLSearchParams(window.location.search).get("utm_medium"),
              utm_content: new URLSearchParams(window.location.search).get("utm_content"),
              utm_campaign: new URLSearchParams(window.location.search).get("utm_campaign")
            })
          }).catch(e => console.log("Analytics:", e));

          const emailForm = document.getElementById("emailCaptureForm");
          emailForm?.addEventListener("submit", async (e) => {
            e.preventDefault();
            const msg = document.getElementById("emailCaptureMsg");
            const email = document.getElementById("captureEmail").value;
            const name = document.getElementById("captureName").value;
            try {
              const res = await fetch("/api/email/capture", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ pageId: "${page.id}", email, name }),
              });
              const data = await res.json();
              if (!res.ok) {
                msg.textContent = data.error || "Subscription failed";
                msg.style.color = "#dc2626";
                return;
              }
              msg.textContent = data.duplicate
                ? "You're already subscribed."
                : "Thanks for subscribing.";
              msg.style.color = "#2563eb";
              emailForm.reset();
            } catch {
              msg.textContent = "Could not subscribe right now.";
              msg.style.color = "#dc2626";
            }
          });
        </script>
      </body>
      </html>
    `;

    res.send(fullPage);
  } catch (e) {
    res.status(500).send("<h1>Error loading landing page</h1>");
  }
});

app.listen(PORT, () => {
  console.log(`TOJ CSV app running → http://localhost:${PORT}`);
  
  // Initialize automatic report schedulers
  initializeSchedulers();
});
