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
      check("BASE_URL"),
      check("SESSION_SECRET"),
    ].join(" · ")
  );
})();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "5mb" }));
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

app.use(
  session({
    secret: process.env.SESSION_SECRET || "toj-dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }, // 1 week
  })
);

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
  "/intake.html": "/foundation-score.html",
  "/instructors.html": "/how-we-work.html",
};
Object.entries(legacyRedirects).forEach(([from, to]) => {
  app.get(from, (req, res) => res.redirect(301, to));
});

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
app.use("/api/rag", requireAuth, require("./routes/rag"));

// Small helper to check auth from frontend
app.get("/api/me", (req, res) => {
  if (req.session && req.session.userEmail) {
    return res.json({ authenticated: true, email: req.session.userEmail });
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
