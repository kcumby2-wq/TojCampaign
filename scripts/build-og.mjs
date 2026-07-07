// Open Graph social-share card generator for TOJ Campaign.
//
// Renders four 1200x630 "split color-block" PNG cards (a master card plus one
// per vertical) into public/og/. Output is committed as static files and served
// by express.static / Vercel — there is NO runtime dependency on this script or
// on Playwright. Re-run only when the card design or copy changes.
//
// Regenerate:
//   cd /home/user/TojCampaign && node scripts/build-og.mjs
//
// Playwright is resolved from the global install at /opt/node22/lib/node_modules
// (override with GLOBAL_MODULES); Chromium is provided by the environment at
// /opt/pw-browsers (override the binary with PW_CHROMIUM).

import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";
import { fontFaceCss } from "./font-css.mjs";

// Playwright is installed globally (not a project dependency). Resolve it from
// the global node_modules so this build script needs nothing added to package.json.
const require = createRequire(
  (process.env.GLOBAL_MODULES || "/opt/node22/lib/node_modules") + "/"
);
const { chromium } = require("playwright");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "public", "og");

const GOLD = "#B8843B";

// Embedded @font-face rules (scripts/fonts/*.woff2 via font-css.mjs); filled at
// startup so card renders never depend on fetching Google Fonts at run time.
let FONT_CSS = "";

const cards = [
  {
    key: "master",
    panel: "#1A1613",
    eyebrowLeft: "TRAIL OF JOY",
    labelMain: "TOJ",
    labelSub: "CAMPAIGN",
    eyebrowRight: "ONE STANDARD · THREE VERTICALS",
    headline: "Build the business that doesn’t collapse when you step away.",
    headlineSize: 50,
    subhead: "Personal brand · Nonprofit · A career in sport.",
    footerTag: "TRAIL OF JOY PMG",
  },
  {
    key: "personal",
    panel: "#A85F26",
    eyebrowLeft: "VERTICAL 01",
    labelMain: "PERSONAL",
    labelSub: "BRAND",
    eyebrowRight: "FOUNDATION SCORE",
    headline: "The system underneath your name.",
    headlineSize: 58,
    subhead: "For solo operators. Five pillars, written Transcript, 72 business hours.",
    footerTag: "72-HOUR TRANSCRIPT",
  },
  {
    key: "nonprofit",
    panel: "#2F5D4E",
    eyebrowLeft: "VERTICAL 02",
    labelMain: "NONPROFIT",
    labelSub: "",
    eyebrowRight: "FOUNDATION SCORE",
    headline: "The system underneath the mission.",
    headlineSize: 58,
    subhead: "For 501(c)(3) directors. Five pillars, written Transcript, 72 business hours.",
    footerTag: "72-HOUR TRANSCRIPT",
  },
  {
    key: "authority",
    panel: "#1E3A5F",
    eyebrowLeft: "VERTICAL 03",
    labelMain: "AUTHORITY",
    labelSub: "",
    eyebrowRight: "FOUNDATION SCORE",
    headline: "The receipts underneath the reputation.",
    headlineSize: 54,
    subhead: "For athletes &amp; programs. Five pillars, written Transcript, 72 business hours.",
    footerTag: "72-HOUR TRANSCRIPT",
  },
];

function cardHtml(c) {
  const label = c.labelSub ? `${c.labelMain}<br>${c.labelSub}` : c.labelMain;
  const subhead = c.subhead ? `<div class="subhead">${c.subhead}</div>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<style>
${FONT_CSS}
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:1200px;height:630px}
  .card{width:1200px;height:630px;display:flex;background:#F5F1EA;font-family:'Manrope',sans-serif;overflow:hidden}
  .left{width:430px;flex:none;background:${c.panel};color:#F5F1E8;padding:56px 48px;display:flex;flex-direction:column;justify-content:space-between}
  .mark{width:74px;height:74px;border-radius:12px;background:rgba(245,241,232,0.10);border:1.5px solid rgba(245,241,232,0.34);display:flex;align-items:center;justify-content:center;font-family:'Anton',sans-serif;font-size:20px;letter-spacing:.02em;color:#F5F1E8}
  .left .eyebrow{font-family:'JetBrains Mono',monospace;font-size:15px;font-weight:600;letter-spacing:.24em;text-transform:uppercase;color:rgba(245,241,232,0.72);margin-bottom:14px}
  .label{font-family:'Anton',sans-serif;font-size:52px;line-height:.94;text-transform:uppercase;letter-spacing:.006em;color:#F5F1E8}
  .rule{width:60px;height:5px;background:${GOLD};margin-top:22px;border-radius:2px}
  .right{flex:1;padding:60px;display:flex;flex-direction:column;justify-content:space-between}
  .right .eyebrow{font-family:'JetBrains Mono',monospace;font-size:14px;font-weight:600;letter-spacing:.2em;text-transform:uppercase;color:#6E655C}
  .headline{font-family:'Fraunces','Georgia',serif;font-weight:600;font-size:${c.headlineSize}px;line-height:1.04;letter-spacing:-.02em;color:#1A1613;margin-top:22px;max-width:640px}
  .subhead{font-family:'Manrope',sans-serif;font-weight:500;font-size:23px;line-height:1.42;color:#3B3530;margin-top:22px;max-width:600px}
  .foot{border-top:1px solid rgba(26,22,19,0.16);padding-top:20px;display:flex;align-items:center;justify-content:space-between}
  .foot .url{font-family:'JetBrains Mono',monospace;font-size:18px;font-weight:600;color:#1A1613;letter-spacing:.01em}
  .foot .tag{font-family:'JetBrains Mono',monospace;font-size:12.5px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:#8A6D3B;display:flex;align-items:center;gap:8px}
  .foot .tag::before{content:'';width:8px;height:8px;border-radius:50%;background:${GOLD}}
</style></head>
<body>
  <div class="card">
    <div class="left">
      <div class="mark">TOJ</div>
      <div>
        <div class="eyebrow">${c.eyebrowLeft}</div>
        <div class="label">${label}</div>
        <div class="rule"></div>
      </div>
    </div>
    <div class="right">
      <div>
        <div class="eyebrow">${c.eyebrowRight}</div>
        <div class="headline">${c.headline}</div>
        ${subhead}
      </div>
      <div class="foot">
        <div class="url">tojcampaign.com</div>
        <div class="tag">${c.footerTag}</div>
      </div>
    </div>
  </div>
</body></html>`;
}

async function main() {
  FONT_CSS = await fontFaceCss();
  await mkdir(OUT_DIR, { recursive: true });

  const launchOpts = {
    executablePath: process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  };
  if (process.env.HTTPS_PROXY) {
    launchOpts.proxy = { server: process.env.HTTPS_PROXY };
  }

  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  for (const c of cards) {
    await page.setContent(cardHtml(c), { waitUntil: "networkidle" });
    // Ensure webfonts have finished loading before the screenshot.
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await page.waitForTimeout(250);
    const out = path.join(OUT_DIR, `og-${c.key}.png`);
    await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1200, height: 630 } });
    console.log(`✓ og-${c.key}.png`);
  }

  await browser.close();
  console.log(`\nDone — 4 cards written to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
