// Shared @font-face CSS for the brand-asset generators (build-og.mjs,
// build-logos.mjs). Fonts are embedded as base64 data URIs from the woff2
// files in scripts/fonts/ so renders are deterministic — the agent proxy
// resets fonts.googleapis.com connections intermittently, which silently
// swapped Anton for a system fallback when fetched at render time.
//
// Files (all SIL OFL licensed, latin subsets from Google Fonts):
//   anton-400.woff2       Anton 400 (static)
//   fraunces-600.woff2    Fraunces 600, opsz variable
//   jetbrains-mono.woff2  JetBrains Mono, wght variable 100-800
//   manrope.woff2         Manrope, wght variable 200-800

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fonts");

async function face(file, family, weight) {
  const b64 = (await readFile(path.join(FONT_DIR, file))).toString("base64");
  return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};src:url(data:font/woff2;base64,${b64}) format('woff2')}`;
}

export async function fontFaceCss() {
  const faces = await Promise.all([
    face("anton-400.woff2", "Anton", "400"),
    face("fraunces-600.woff2", "Fraunces", "600"),
    face("jetbrains-mono.woff2", "JetBrains Mono", "100 800"),
    face("manrope.woff2", "Manrope", "200 800"),
  ]);
  return faces.join("\n");
}
