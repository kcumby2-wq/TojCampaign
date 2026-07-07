// Trail of Joy — brand avatar (profile-picture) builder.
//
// The chosen mark is "The Tile": heavy Anton TOJ + gold rule on ink — the
// canonical version of the mark already living in the site favicons and the
// OG-card chips. This script writes the vector source (toj-avatar.svg, fonts
// embedded) and renders the PNG avatar set every platform needs:
//
//   public/brand/toj-avatar.svg        vector source of truth
//   public/brand/toj-avatar-1024.png   master
//   public/brand/toj-avatar-512.png    general purpose
//   public/brand/toj-avatar-400.png    X / Twitter
//   public/brand/toj-avatar-320.png    Instagram
//   public/brand/toj-avatar-180.png    Facebook minimum
//
// Run:
//   node scripts/build-logos.mjs                render final avatar set
//   node scripts/build-logos.mjs --concepts DIR re-render the exploration
//                                               (Tile / Seal / Trail + lineup)
//
// Fonts are embedded from scripts/fonts/*.woff2 (see font-css.mjs) so renders
// never fetch from the network. Same Playwright/Chromium pipeline as
// scripts/build-og.mjs; output PNGs are committed static files.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";
import { fontFaceCss } from "./font-css.mjs";

const require = createRequire(
  (process.env.GLOBAL_MODULES || "/opt/node22/lib/node_modules") + "/"
);
const { chromium } = require("playwright");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRAND_DIR = path.join(__dirname, "..", "public", "brand");
const AVATAR_SIZES = [1024, 512, 400, 320, 180];

const INK = "#1A1613";
const CREAM = "#F5F1E8";
const GOLD = "#B8843B";

// Filled at startup with embedded @font-face rules — no network at render time.
let FONTS = "";

// ── Final mark · The Tile (vector source) ────────────────────────────────────
async function avatarSvg() {
  const anton = (
    await readFile(path.join(__dirname, "fonts", "anton-400.woff2"))
  ).toString("base64");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 1024 1024">
  <style>@font-face{font-family:'Anton';font-style:normal;font-weight:400;src:url(data:font/woff2;base64,${anton}) format('woff2')}</style>
  <rect width="1024" height="1024" fill="${INK}"/>
  <text x="512" y="600" font-family="Anton" font-size="330" letter-spacing="5" fill="${CREAM}" text-anchor="middle">TOJ</text>
  <rect x="362" y="650" width="300" height="26" rx="7" fill="${GOLD}"/>
</svg>
`;
}

// ── Exploration concepts (kept for the record; re-render with --concepts) ───

const conceptA = () => `<!doctype html><html><head><meta charset="utf-8">${FONTS}
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{width:1024px;height:1024px;background:${INK};display:flex;align-items:center;justify-content:center}
  .stack{display:flex;flex-direction:column;align-items:center;margin-top:-6px}
  .toj{font-family:'Anton',sans-serif;font-size:330px;line-height:1;letter-spacing:.015em;color:${CREAM}}
  .rule{width:300px;height:26px;background:${GOLD};border-radius:7px;margin-top:34px}
</style></head><body>
  <div class="stack"><div class="toj">TOJ</div><div class="rule"></div></div>
</body></html>`;

const conceptB = () => `<!doctype html><html><head><meta charset="utf-8">${FONTS}
<style>*{margin:0;padding:0}body{width:1024px;height:1024px;background:${INK}}</style>
</head><body>
<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <circle cx="512" cy="512" r="474" fill="none" stroke="${GOLD}" stroke-width="7"/>
  <circle cx="512" cy="512" r="446" fill="none" stroke="${GOLD}" stroke-width="2"/>
  <circle cx="512" cy="512" r="302" fill="none" stroke="${GOLD}" stroke-width="2.5"/>
  <defs>
    <path id="arcTop" d="M 142 512 A 370 370 0 0 1 882 512"/>
    <path id="arcBottom" d="M 124 512 A 388 388 0 0 0 900 512"/>
  </defs>
  <text font-family="'JetBrains Mono',monospace" font-size="47" font-weight="600" letter-spacing="0.42em" fill="${CREAM}">
    <textPath href="#arcTop" startOffset="50%" text-anchor="middle">TRAIL OF JOY</textPath>
  </text>
  <text font-family="'JetBrains Mono',monospace" font-size="33" font-weight="600" letter-spacing="0.30em" fill="${CREAM}" opacity="0.88">
    <textPath href="#arcBottom" startOffset="50%" text-anchor="middle">PLAYER MANAGEMENT GROUP</textPath>
  </text>
  <rect x="121" y="499" width="26" height="26" rx="3" transform="rotate(45 134 512)" fill="${GOLD}"/>
  <rect x="877" y="499" width="26" height="26" rx="3" transform="rotate(45 890 512)" fill="${GOLD}"/>
  <text x="512" y="568" text-anchor="middle" font-family="'Anton',sans-serif" font-size="180" letter-spacing="0.02em" fill="${CREAM}">TOJ</text>
  <rect x="434" y="608" width="156" height="15" rx="4" fill="${GOLD}"/>
</svg>
</body></html>`;

const conceptC = () => `<!doctype html><html><head><meta charset="utf-8">${FONTS}
<style>*{margin:0;padding:0}body{width:1024px;height:1024px;background:${INK}}</style>
</head><body>
<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <circle cx="252" cy="798" r="30" fill="none" stroke="${GOLD}" stroke-width="14"/>
  <path d="M 312 792 C 560 812 800 742 796 620 C 792 505 585 532 445 522 C 305 512 258 448 318 378 C 372 315 538 330 642 296"
        fill="none" stroke="${GOLD}" stroke-width="34" stroke-linecap="round" stroke-dasharray="58 46"/>
  <path d="M 700 262 L 717 245 L 700 172 L 683 245 L 700 262 L 717 279 L 700 352 L 683 279 Z
           M 700 262 L 683 245 L 610 262 L 683 279 L 700 262 L 717 279 L 790 262 L 717 245 Z"
        fill="${CREAM}" fill-rule="nonzero"/>
  <circle cx="775" cy="205" r="10" fill="${GOLD}"/>
</svg>
</body></html>`;

const concepts = [
  { key: "a-tile", title: "A · The Tile", html: conceptA },
  { key: "b-seal", title: "B · The Seal", html: conceptB },
  { key: "c-trail", title: "C · The Trail", html: conceptC },
];

function lineupHtml(images) {
  const row = (c) => `
    <div class="row">
      <div class="rowlabel">${c.title}</div>
      <div class="chips">
        <div class="chip light"><img class="av a200 circle" src="${c.b64}"><span>200px · circle</span></div>
        <div class="chip light"><img class="av a200 rounded" src="${c.b64}"><span>200px · square</span></div>
        <div class="chip dark"><img class="av a96 circle" src="${c.b64}"><img class="av a48 circle" src="${c.b64}"><span>96 / 48 · dark feed</span></div>
        <div class="chip lgray"><img class="av a96 circle" src="${c.b64}"><img class="av a48 circle" src="${c.b64}"><span>96 / 48 · light feed</span></div>
      </div>
    </div>`;
  return `<!doctype html><html><head><meta charset="utf-8">${FONTS}
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{width:1520px;background:${CREAM};font-family:'Manrope',sans-serif;padding:48px 56px}
  h1{font-family:'Fraunces',serif;font-weight:600;font-size:40px;color:${INK};letter-spacing:-0.01em}
  .sub{font-family:'JetBrains Mono',monospace;font-size:14px;letter-spacing:.18em;text-transform:uppercase;color:#8A8570;margin:10px 0 34px}
  .row{margin-bottom:34px}
  .rowlabel{font-family:'Fraunces',serif;font-size:24px;font-weight:600;color:${INK};margin-bottom:12px}
  .chips{display:flex;gap:18px}
  .chip{border-radius:14px;padding:20px;display:flex;align-items:center;gap:16px;border:1px solid rgba(26,22,19,.14)}
  .chip span{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.12em;text-transform:uppercase}
  .light{background:#FFFFFF;color:#8A8570}
  .lgray{background:#F3F2EF;color:#8A8570}
  .dark{background:#15202B;color:rgba(255,255,255,.55)}
  .av{display:block}
  .a200{width:200px;height:200px}
  .a96{width:96px;height:96px}
  .a48{width:48px;height:48px}
  .circle{border-radius:50%}
  .rounded{border-radius:18px}
</style></head><body>
  <h1>Trail of Joy — profile picture concepts</h1>
  <div class="sub">1024×1024 masters · shown as feed avatars, circle-cropped</div>
  ${images.map(row).join("")}
</body></html>`;
}

async function launch() {
  const opts = {
    executablePath: process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  };
  if (process.env.HTTPS_PROXY) opts.proxy = { server: process.env.HTTPS_PROXY };
  return chromium.launch(opts);
}

async function renderAvatars() {
  await mkdir(BRAND_DIR, { recursive: true });
  const svg = await avatarSvg();
  await writeFile(path.join(BRAND_DIR, "toj-avatar.svg"), svg);
  console.log("✓ toj-avatar.svg");

  const dataUrl =
    "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");

  const browser = await launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  for (const size of AVATAR_SIZES) {
    await page.setViewportSize({ width: size, height: size });
    await page.goto(dataUrl, { waitUntil: "load" });
    await page.evaluate(async () => {
      if (document.fonts) await document.fonts.ready;
    });
    await page.waitForTimeout(200);
    const out = path.join(BRAND_DIR, `toj-avatar-${size}.png`);
    await page.screenshot({ path: out, clip: { x: 0, y: 0, width: size, height: size } });
    console.log(`✓ toj-avatar-${size}.png`);
  }

  await browser.close();
  console.log(`\nDone — avatar set written to ${BRAND_DIR}`);
}

async function renderConcepts(outDir) {
  await mkdir(outDir, { recursive: true });
  const browser = await launch();
  const context = await browser.newContext({
    viewport: { width: 1024, height: 1024 },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  const rendered = [];
  for (const c of concepts) {
    await page.setContent(c.html(), { waitUntil: "networkidle" });
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.waitForTimeout(250);
    const out = path.join(outDir, `logo-concept-${c.key}.png`);
    await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1024, height: 1024 } });
    const b64 = `data:image/png;base64,${(await readFile(out)).toString("base64")}`;
    rendered.push({ ...c, b64 });
    console.log(`✓ logo-concept-${c.key}.png`);
  }

  const sheet = await context.newPage();
  await sheet.setViewportSize({ width: 1520, height: 1180 });
  await sheet.setContent(lineupHtml(rendered), { waitUntil: "networkidle" });
  await sheet.evaluate(async () => { await document.fonts.ready; });
  await sheet.waitForTimeout(250);
  await sheet.screenshot({ path: path.join(outDir, "logo-lineup.png"), fullPage: true });
  console.log("✓ logo-lineup.png");

  await browser.close();
  console.log(`\nDone — concepts written to ${outDir}`);
}

async function main() {
  FONTS = `<style>${await fontFaceCss()}</style>`;
  const args = process.argv.slice(2);
  if (args[0] === "--concepts") {
    await renderConcepts(path.resolve(args[1] || "logo-concepts"));
  } else {
    await renderAvatars();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
