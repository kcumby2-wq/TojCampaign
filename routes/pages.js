const express = require("express");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const router = express.Router();
const PAGES_FILE = path.join(__dirname, "..", "db", "landing_pages.json");
const TEMPLATES_FILE = path.join(__dirname, "..", "db", "templates_data.json");
const MARKETPLACE_FILE = path.join(__dirname, "..", "db", "marketplace_templates.json");
const PURCHASES_FILE = path.join(__dirname, "..", "db", "marketplace_purchases.json");

function loadPages() {
  if (!fs.existsSync(PAGES_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(PAGES_FILE, "utf8"));
  } catch {
    return [];
  }
}

function savePages(pages) {
  fs.writeFileSync(PAGES_FILE, JSON.stringify(pages, null, 2));
}

function loadTemplates() {
  if (!fs.existsSync(TEMPLATES_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(TEMPLATES_FILE, "utf8"));
  } catch {
    return [];
  }
}

function loadMarketplaceTemplates() {
  if (!fs.existsSync(MARKETPLACE_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(MARKETPLACE_FILE, "utf8"));
  } catch {
    return [];
  }
}

function loadPurchases() {
  if (!fs.existsSync(PURCHASES_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(PURCHASES_FILE, "utf8"));
  } catch {
    return [];
  }
}

// GET /api/pages - List user's landing pages
router.get("/", (req, res) => {
  if (!req.session?.userEmail) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const pages = loadPages();
  const userPages = pages.filter((p) => p.ownerEmail === req.session.userEmail);
  res.json(userPages);
});

// GET /api/pages/templates - Get available templates
router.get("/templates", (req, res) => {
  if (!req.session?.userEmail) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const templates = loadTemplates().map((t) => ({
    ...t,
    isPremium: false,
    unlocked: true,
  }));
  const marketplaceTemplates = loadMarketplaceTemplates();
  const purchases = loadPurchases();
  const owned = new Set(
    purchases
      .filter((p) => p.userEmail === req.session.userEmail)
      .map((p) => p.templateId)
  );

  const unlockedMarketplace = marketplaceTemplates
    .filter((t) => owned.has(t.id))
    .map((t) => ({ ...t, unlocked: true }));

  res.json([...templates, ...unlockedMarketplace]);
});

// POST /api/pages - Create new landing page
router.post("/", (req, res) => {
  if (!req.session?.userEmail) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const { templateId, pageTitle, customizations } = req.body;

  if (!templateId || !pageTitle) {
    return res.status(400).json({ error: "templateId and pageTitle required" });
  }

  const pages = loadPages();
  const templates = [
    ...loadTemplates(),
    ...loadMarketplaceTemplates().filter((t) =>
      loadPurchases().some(
        (p) => p.userEmail === req.session.userEmail && p.templateId === t.id
      )
    ),
  ];
  const template = templates.find((t) => t.id === templateId);

  if (!template) {
    return res.status(404).json({ error: "Template not found" });
  }

  const newPage = {
    id: randomUUID(),
    ownerEmail: req.session.userEmail,
    templateId,
    pageTitle,
    slug: pageTitle.toLowerCase().replace(/\s+/g, "-"),
    customizations: customizations || {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    clicks: 0,
    published: false,
  };

  pages.push(newPage);
  savePages(pages);

  res.json(newPage);
});

// PUT /api/pages/:pageId - Update landing page
router.put("/:pageId", (req, res) => {
  if (!req.session?.userEmail) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const { pageId } = req.params;
  const { pageTitle, customizations, published } = req.body;

  const pages = loadPages();
  const pageIndex = pages.findIndex(
    (p) => p.id === pageId && p.ownerEmail === req.session.userEmail
  );

  if (pageIndex === -1) {
    return res.status(404).json({ error: "Page not found" });
  }

  const page = pages[pageIndex];
  if (pageTitle) page.pageTitle = pageTitle;
  if (customizations) page.customizations = customizations;
  if (typeof published === "boolean") page.published = published;
  page.updatedAt = new Date().toISOString();

  pages[pageIndex] = page;
  savePages(pages);

  res.json(page);
});

// DELETE /api/pages/:pageId - Delete landing page
router.delete("/:pageId", (req, res) => {
  if (!req.session?.userEmail) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const { pageId } = req.params;
  const pages = loadPages();
  const filteredPages = pages.filter(
    (p) => !(p.id === pageId && p.ownerEmail === req.session.userEmail)
  );

  if (filteredPages.length === pages.length) {
    return res.status(404).json({ error: "Page not found" });
  }

  savePages(filteredPages);
  res.json({ success: true });
});

// GET /api/pages/:pageId/stats - Get page analytics
router.get("/:pageId/stats", (req, res) => {
  if (!req.session?.userEmail) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const { pageId } = req.params;
  const pages = loadPages();
  const page = pages.find(
    (p) => p.id === pageId && p.ownerEmail === req.session.userEmail
  );

  if (!page) {
    return res.status(404).json({ error: "Page not found" });
  }

  res.json({
    pageId,
    clicks: page.clicks,
    createdAt: page.createdAt,
    url: `${process.env.BASE_URL || "http://localhost:3000"}/pages/${page.slug}`,
  });
});

module.exports = router;
