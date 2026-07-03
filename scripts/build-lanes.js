#!/usr/bin/env node
// Pre-renders public/lane.html into one static HTML file per avenue so a
// static host (Vercel) can serve them without running server.js. Keep the
// LANES map in sync with server.js — server.js is the source of truth for
// production; this script mirrors it for the static build.

const fs = require("fs");
const path = require("path");

const LANES = {
  sports: {
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
  smallbusiness: {
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
  bigbusiness: {
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
  advisory: {
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

const publicDir = path.join(__dirname, "..", "public");
const template = fs.readFileSync(path.join(publicDir, "lane.html"), "utf8");

for (const [slug, lane] of Object.entries(LANES)) {
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
  let html = template;
  for (const [k, v] of Object.entries(tokens)) {
    html = html.split(`{{${k}}}`).join(v);
  }
  const outPath = path.join(publicDir, `${slug}.html`);
  fs.writeFileSync(outPath, html, "utf8");
  console.log(`wrote ${outPath}`);
}
