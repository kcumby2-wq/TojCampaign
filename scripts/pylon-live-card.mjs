#!/usr/bin/env node
// pylon-live-card.mjs
// Real-time card generator for Pylon Live Event Console (SKU #10).
//
// Called from routes/pylon.js after /api/pylon/live-posts creates a post row.
// Takes JSON payload → generates 1080×1350 (IG) + 1200×675 (Twitter) cards
// in Pylon aesthetic (yellow/black diamond, Anton typography).
//
// Usage:
//   node scripts/pylon-live-card.mjs --input payload.json --outdir output/pylon-cards/
//   cat payload.json | node scripts/pylon-live-card.mjs --outdir output/pylon-cards/
//
// Or programmatically:
//   import { renderPylonCard } from './scripts/pylon-live-card.mjs';
//   await renderPylonCard(payload, outDir);
//
// Payload shape:
//   {
//     post_id: uuid,               // matches pylon_live_posts.id
//     post_type: string,           // 'stat_card' | 'play_of_the_day' | 'athlete_of_the_half' | 'ranking_drop' | 'sponsor_bumper'
//     team_name: string,
//     athlete_name: string,
//     position: string,
//     stat_type: string,           // 'Passing Yards' | 'Receiving Yards' | etc
//     stat_value: number,
//     event_name: string,
//     event_date: string (ISO),
//     sponsor_tag?: string,
//     score?: { home: number, away: number, quarter: string },
//   }
//
// Fonts: Anton + JetBrains Mono + Inter. Loaded via woff2 in scripts/fonts/.
// If missing, script fails clean with instructions (same pattern as
// hooks-os weekly-stats-cards).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// ─── Pylon brand tokens (must match V2.9 spec) ────────────────────────────
const PYLON = {
  black: '#0A0A0A',
  yellow: '#F4C82E',
  yellowSecondary: '#FFE066',
  white: '#FFFFFF',
  darkSurface: '#1A1A1A',
};

// ─── Dimensions per platform ───────────────────────────────────────────────
const SIZES = {
  ig: { w: 1080, h: 1350 },
  twitter: { w: 1200, h: 675 },
};

// ═════════════════════════════════════════════════════════════════════════
// Public API
// ═════════════════════════════════════════════════════════════════════════

export async function renderPylonCard(payload, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ deviceScaleFactor: 2 });
  const results = {};
  try {
    for (const [platform, size] of Object.entries(SIZES)) {
      const html = buildCardHTML(payload, size, platform);
      const filename = `${payload.post_id || 'card'}-${platform}.png`;
      const filepath = path.join(outDir, filename);
      const page = await context.newPage();
      await page.setViewportSize(size);
      await page.setContent(html, { waitUntil: 'load' });
      await page.waitForTimeout(120);
      await page.screenshot({
        path: filepath,
        type: 'png',
        clip: { x: 0, y: 0, width: size.w, height: size.h },
      });
      await page.close();
      results[platform] = filepath;
    }
  } finally {
    await browser.close();
  }
  return results;
}

// ═════════════════════════════════════════════════════════════════════════
// Card HTML builder
// ═════════════════════════════════════════════════════════════════════════

function buildCardHTML(payload, size, platform) {
  const isIg = platform === 'ig';
  const {
    post_type = 'stat_card',
    team_name = '',
    athlete_name = '',
    position = '',
    stat_type = '',
    stat_value = 0,
    event_name = '',
    sponsor_tag = '',
    score,
  } = payload;

  // Post-type styling
  const eyebrow = eyebrowFor(post_type);

  // Scaled font sizes based on platform
  const fs = isIg
    ? { eyebrow: 22, athlete: 100, stat: 240, statLabel: 34, context: 26, event: 20, sponsor: 22 }
    : { eyebrow: 18, athlete: 68, stat: 168, statLabel: 26, context: 20, event: 16, sponsor: 18 };

  const padding = isIg ? 72 : 56;

  return `<!doctype html>
<html>
<head>
<style>
${loadFontsCss()}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
  width: 100%;
  height: 100%;
  background: ${PYLON.black};
  color: ${PYLON.white};
  font-family: 'Inter', -apple-system, sans-serif;
  -webkit-font-smoothing: antialiased;
  overflow: hidden;
}
.card {
  width: ${size.w}px;
  height: ${size.h}px;
  padding: ${padding}px;
  background: ${PYLON.black};
  position: relative;
  display: flex;
  flex-direction: column;
}
/* Pylon corner diamonds — brand mark */
.diamond {
  position: absolute;
  width: 60px;
  height: 60px;
  background: ${PYLON.yellow};
}
.diamond::before {
  content: '';
  position: absolute;
  inset: 14px;
  background: ${PYLON.black};
}
.diamond.tl { top: ${padding}px; left: ${padding}px; }
.diamond.br { bottom: ${padding}px; right: ${padding}px; }

/* Yellow accent line under eyebrow */
.eyebrow {
  font-family: 'JetBrains Mono', monospace;
  font-size: ${fs.eyebrow}px;
  color: ${PYLON.yellow};
  letter-spacing: 0.24em;
  text-transform: uppercase;
  font-weight: 700;
  margin-top: ${padding + 12}px;
  padding-bottom: 14px;
  border-bottom: 3px solid ${PYLON.yellow};
  display: inline-block;
  align-self: flex-start;
  max-width: 80%;
}

/* Push stat content to the middle-bottom */
.spacer { flex: 1; }

.athlete {
  font-family: 'Anton', sans-serif;
  font-size: ${fs.athlete}px;
  color: ${PYLON.white};
  text-transform: uppercase;
  letter-spacing: -0.015em;
  line-height: 0.92;
  margin-bottom: 12px;
  max-width: 100%;
  word-wrap: break-word;
}
.athlete .accent { color: ${PYLON.yellow}; }

.stat-block {
  display: flex;
  align-items: baseline;
  gap: 20px;
  margin: ${isIg ? '10px' : '4px'} 0 ${isIg ? '18px' : '10px'};
}
.stat-value {
  font-family: 'Anton', sans-serif;
  font-size: ${fs.stat}px;
  color: ${PYLON.yellow};
  line-height: 0.9;
  letter-spacing: -0.03em;
}
.stat-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: ${fs.statLabel}px;
  color: ${PYLON.white};
  letter-spacing: 0.14em;
  text-transform: uppercase;
  font-weight: 700;
  line-height: 1.1;
  max-width: ${isIg ? 380 : 240}px;
}

.context {
  font-family: 'JetBrains Mono', monospace;
  font-size: ${fs.context}px;
  color: rgba(255,255,255,0.72);
  letter-spacing: 0.16em;
  text-transform: uppercase;
  font-weight: 700;
  margin-bottom: 10px;
}

.event-line {
  font-family: 'JetBrains Mono', monospace;
  font-size: ${fs.event}px;
  color: ${PYLON.yellow};
  letter-spacing: 0.24em;
  text-transform: uppercase;
  font-weight: 700;
  padding-top: 16px;
  border-top: 1px solid rgba(244,200,46,0.3);
  margin-top: 20px;
}

.sponsor-line {
  font-family: 'JetBrains Mono', monospace;
  font-size: ${fs.sponsor}px;
  color: ${PYLON.yellow};
  letter-spacing: 0.2em;
  text-transform: uppercase;
  font-weight: 700;
  margin-top: 8px;
}

/* Score chip · shown if score data present */
.score-chip {
  position: absolute;
  top: ${padding}px;
  right: ${padding}px;
  background: ${PYLON.darkSurface};
  border: 2px solid ${PYLON.yellow};
  padding: 12px 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.score-chip .score {
  font-family: 'Anton', sans-serif;
  font-size: ${isIg ? 32 : 24}px;
  color: ${PYLON.yellow};
  line-height: 1;
  letter-spacing: -0.005em;
}
.score-chip .quarter {
  font-family: 'JetBrains Mono', monospace;
  font-size: ${isIg ? 12 : 10}px;
  color: rgba(255,255,255,0.72);
  letter-spacing: 0.16em;
  text-transform: uppercase;
  font-weight: 700;
}
</style>
</head>
<body>
<div class="card">
  <div class="diamond tl"></div>
  <div class="diamond br"></div>
  ${score ? `<div class="score-chip"><div class="score">${score.home}–${score.away}</div><div class="quarter">Q${score.quarter}</div></div>` : ''}

  <div class="eyebrow">${escapeHtml(eyebrow)}</div>

  <div class="spacer"></div>

  <div class="athlete">${escapeHtml(athlete_name)}${position ? ` <span class="accent">· ${escapeHtml(position)}</span>` : ''}</div>

  <div class="stat-block">
    <div class="stat-value">${formatValue(stat_value)}</div>
    <div class="stat-label">${escapeHtml(stat_type)}</div>
  </div>

  <div class="context">${escapeHtml(team_name)}</div>

  <div class="event-line">${escapeHtml(event_name)}</div>
  ${sponsor_tag ? `<div class="sponsor-line">Presented by ${escapeHtml(sponsor_tag)}</div>` : ''}
</div>
</body>
</html>`;
}

function eyebrowFor(postType) {
  const map = {
    stat_card: 'Live · Stat Card',
    play_of_the_day: 'Play of the Day',
    athlete_of_the_half: 'Athlete of the Half',
    ranking_drop: 'Rankings · Movement',
    sponsor_bumper: 'Presented By',
  };
  return map[postType] || 'Live';
}

function formatValue(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n.toLocaleString('en-US');
}

function escapeHtml(s) {
  return String(s || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// ═════════════════════════════════════════════════════════════════════════
// Font loader — embeds woff2 as base64 data URIs. No Google Fonts fetch.
// ═════════════════════════════════════════════════════════════════════════

function loadFontsCss() {
  const fontDir = path.join(__dirname, 'fonts');
  const map = {
    'Anton': 'Anton-Regular.woff2',
    'JetBrains Mono': 'JetBrainsMono-Regular.woff2',
    'Inter': 'Inter-Regular.woff2',
  };
  const missing = [];
  const decl = [];
  for (const [family, file] of Object.entries(map)) {
    const p = path.join(fontDir, file);
    if (!fs.existsSync(p)) {
      missing.push(file);
      continue;
    }
    const b64 = fs.readFileSync(p).toString('base64');
    decl.push(`@font-face { font-family: '${family}'; src: url(data:font/woff2;base64,${b64}) format('woff2'); font-display: block; }`);
  }
  if (missing.length) {
    console.error(`\n✗ Missing font files in scripts/fonts/:\n  ${missing.join('\n  ')}`);
    console.error(`\nDownload the woff2 for each family (Anton, JetBrains Mono, Inter) from the`);
    console.error(`family's official source and drop into scripts/fonts/ with the exact filenames above.`);
    console.error(`Cards will not render with fallback fonts — the brand demands the real typography.\n`);
    process.exit(2);
  }
  return decl.join('\n');
}

// ═════════════════════════════════════════════════════════════════════════
// CLI
// ═════════════════════════════════════════════════════════════════════════

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[key] = val;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = args.outdir || path.join(REPO_ROOT, 'output/pylon-cards');
  let payloadJson;
  if (args.input) {
    payloadJson = fs.readFileSync(path.resolve(REPO_ROOT, args.input), 'utf8');
  } else if (!process.stdin.isTTY) {
    payloadJson = fs.readFileSync(0, 'utf8');
  } else {
    console.error('Usage: pylon-live-card.mjs --input payload.json [--outdir OUT]');
    console.error('   or: cat payload.json | node scripts/pylon-live-card.mjs [--outdir OUT]');
    process.exit(2);
  }
  const payload = JSON.parse(payloadJson);
  console.log(`\n▸ Rendering Pylon Live Card · post_id=${payload.post_id || '(none)'}`);
  const results = await renderPylonCard(payload, outDir);
  console.log(`✓ IG:       ${path.relative(REPO_ROOT, results.ig)}`);
  console.log(`✓ Twitter:  ${path.relative(REPO_ROOT, results.twitter)}`);
  console.log(`\nReady for handoff to /api/pylon/live-posts/:id/publish channels.`);
}

// Run CLI if invoked directly (not imported)
const isDirect = import.meta.url === `file://${process.argv[1]}` || import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`;
if (isDirect) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
