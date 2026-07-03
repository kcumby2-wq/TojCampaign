const express = require("express");
const session = require("express-session");
const path = require("path");
const fs = require("fs");

// Initialize report schedulers
const { initializeSchedulers } = require("./utils/reportScheduler");

// Per-subdomain lane content — shared front-end for the four avenues.
const LANES = {
  "sports.tojcampaign.com": {
    title: "TOJ Sports",
    avenue: "Avenue 01",
    domain: "sports.tojcampaign.com",
    color: "#1E3A5F",
    meta: "TOJ Sports — the avenue for athletes, trainers, sports media creators, and organizations adjacent to sport. Premium tier with dedicated GHL sub-account.",
    tagline: "Anyone whose business is sport. Athletes, trainers, sports media creators, organizations adjacent to sport.",
    whoHead: "Built for people whose product IS the sport.",
    whoBody: "TOJ Sports routes serious athletes, trainer brands, and sports-adjacent orgs into a Premium operating stack — with their own GHL sub-account, verified roster, and Subject Report grading.",
    tier: "Premium · Own GHL sub-account",
    insideLabel: "Inside TOJ Sports",
    insideItems: [
      "Athletes Certified roster",
      "Subject Report (TOJ × Optimum Grading)",
      "Subject Medias booking",
      "Apex trainer operating brains",
    ],
  },
  "smallbusiness.tojcampaign.com": {
    title: "TOJ Small Business",
    avenue: "Avenue 02",
    domain: "smallbusiness.tojcampaign.com",
    color: "#A85F26",
    meta: "TOJ Small Business — the avenue for relationship-built operators. Solo coaches, neighborhood shops, small programs, non-sports creators. Basic tier via the Creator Intake System.",
    tagline: "Relationship-built operators. Solo or small-team businesses where the brand is genuinely the person running it.",
    whoHead: "For operators whose brand IS the person running it.",
    whoBody: "TOJ Small Business is the front door for solo coaches, neighborhood shops, small athletic programs, and non-sports creators — one standard, one intake, delivered through the Creator Intake System app.",
    tier: "Basic · Creator Intake System app",
    insideLabel: "Who it serves",
    insideItems: [
      "Solo coaches & instructors",
      "Neighborhood shops & local trades",
      "Programs, 7v7, school athletics",
      "Non-sports creators (small audience)",
    ],
  },
  "bigbusiness.tojcampaign.com": {
    title: "TOJ Big Business",
    avenue: "Avenue 03",
    domain: "bigbusiness.tojcampaign.com",
    color: "#2F5D4E",
    meta: "TOJ Big Business — the avenue for established multi-location operators, regional service companies, and multi-division businesses where one standard needs to cross divisions.",
    tagline: "Established multi-location operators, regional service companies, multi-division businesses where one standard needs to cross divisions.",
    whoHead: "For operators where one standard has to cross divisions.",
    whoBody: "TOJ Big Business runs the same architecture across multiple locations, teams, and business units — so an HVAC group, a multi-studio fitness brand, or a regional B2B provider all get one Operational Transcript with per-division rollups.",
    tier: "Basic or Premium · per-engagement",
    insideLabel: "Who it serves",
    insideItems: [
      "Multi-location HVAC, plumbing, contracting",
      "Multi-studio fitness / music / dance",
      "Regional service companies (10+ staff)",
      "B2B providers with team structure",
    ],
  },
  "advisory.tojcampaign.com": {
    title: "TOJ Advisory",
    avenue: "Avenue 04",
    domain: "advisory.tojcampaign.com",
    color: "#B8843B",
    meta: "TOJ Advisory — the coaching front door for young athletes and sports creators building personal brands. SubjectSkillz curriculum + 1:1 advisory cadence.",
    tagline: "Individuals building their own brand who need a coach, not full operations — young sports creators and athletes building personal brands.",
    whoHead: "For the ones building a brand, not running an operation yet.",
    whoBody: "TOJ Advisory is the mentorship track. Young athletes and sports creators get the SubjectSkillz curriculum, a 1:1 advisory cadence, and a quarterly Transcript — with a curated peer cohort walking the trail alongside them.",
    tier: "Advisory · No sub-account per mentee",
    insideLabel: "What you get",
    insideItems: [
      "SubjectSkillz mentorship curriculum",
      "1:1 advisory cadence",
      "Brand framework + quarterly Transcript",
      "Curated peer cohort",
    ],
  },
};

const LANE_TEMPLATE_PATH = path.join(__dirname, "public", "lane.html");
let LANE_TEMPLATE_CACHE = null;
function loadLaneTemplate() {
  if (!LANE_TEMPLATE_CACHE) {
    LANE_TEMPLATE_CACHE = fs.readFileSync(LANE_TEMPLATE_PATH, "utf8");
  }
  return LANE_TEMPLATE_CACHE;
}

function renderLane(lane) {
  const tokens = {
    LANE_TITLE: lane.title,
    LANE_AVENUE: lane.avenue,
    LANE_DOMAIN: lane.domain,
    LANE_COLOR: lane.color,
    LANE_META: lane.meta,
    LANE_TAGLINE: lane.tagline,
    LANE_WHO_HEAD: lane.whoHead,
    LANE_WHO_BODY: lane.whoBody,
    LANE_TIER: lane.tier,
    INSIDE_LABEL: lane.insideLabel,
    INSIDE_ITEMS: lane.insideItems.map((i) => `<li>${i}</li>`).join(""),
  };
  let html = loadLaneTemplate();
  for (const [k, v] of Object.entries(tokens)) {
    html = html.split(`{{${k}}}`).join(v);
  }
  return html;
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));

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
app.use("/api", require("./routes/phase1"));

// Per-subdomain lane routing (must run before static so `/` on a subdomain
// hits the lane page instead of falling through to public/index.html).
app.use((req, res, next) => {
  const host = (req.hostname || "").toLowerCase();
  const lane = LANES[host];
  if (lane && (req.path === "/" || req.path === "/index.html")) {
    try {
      return res.type("html").send(renderLane(lane));
    } catch (e) {
      return next(e);
    }
  }
  next();
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
