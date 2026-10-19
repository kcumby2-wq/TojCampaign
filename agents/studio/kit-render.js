// Studio kit renderer — turns a kit (agents/studio/kit.js shape) into the
// Milanote kit page: one section per Milanote column, every card with a copy
// button that puts rich text + plain text on the clipboard.
//
// This is a line-for-line port of the page the Same Work kit was first
// published from (Oct 19, 2026). tests/studio-kit.test.js renders the
// approved baseline and checks the output is byte-identical to that page,
// so a change here that alters the page fails the test. Change the look on
// purpose, and update the test's hash in the same commit.
//
// The page's CSS and copy-button script are the constants at the bottom.

"use strict";

const TYPE_LABEL = { note: "Note", link: "Link", image: "Image", todo: "To-do list" };
const COLOR_VAR = {
  Red: "red", Blue: "blue", Purple: "purple", Yellow: "yellow", Orange: "orange",
  Green: "green", Teal: "teal", Grey: "grey",
};

// Same output as Python's html.escape(s, quote=True).
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

const NAMED = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–",
  hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", middot: "·",
  bull: "•", times: "×", copy: "©", reg: "®", trade: "™", eacute: "é",
};

function unescapeHtml(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, ent) => {
    if (ent[0] === "#") {
      const n = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      try { return String.fromCodePoint(n); } catch { return m; }
    }
    return Object.prototype.hasOwnProperty.call(NAMED, ent) ? NAMED[ent] : m;
  });
}

// HTML card body -> plain text that pastes cleanly.
function toText(h) {
  let s = String(h);
  s = s.replace(/<ol>([\s\S]*?)<\/ol>/g, (_m, inner) => {
    const items = [...inner.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((x) => x[1]);
    return items.map((it, i) => `${i + 1}. ${it}\n`).join("") + "\n";
  });
  s = s.replace(/<li>/g, "• ");
  s = s.replace(/<\/li>/g, "\n");
  s = s.replace(/<\/p>/g, "\n\n");
  s = s.replace(/<br\s*\/?>/g, "\n");
  s = s.replace(/<a href="([^"]+)">(.*?)<\/a>/g, "$2 ($1)");
  s = s.replace(/<[^>]+>/g, "");
  s = unescapeHtml(s);
  s = s.replace(/[ \t]+\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function cardPlain(k) {
  if (k.type === "todo") return k.title + "\n\n" + (k.items || []).map((i) => `☐ ${i}`).join("\n");
  return k.title + "\n\n" + toText(String(k.body || "").trim());
}

function defaultImgSrc(img) {
  return `img/${img}.jpg`;
}

function cardHtml(ci, ki, k, imgSrc) {
  const cid = `c${ci}-${ki}`;
  const title = esc(k.title);
  const t = k.type;
  let body;
  let rich;
  let plain;
  if (t === "todo") {
    body = "<ul class='todo'>" + (k.items || []).map((i) => `<li><span class='box' aria-hidden='true'></span>${esc(i)}</li>`).join("") + "</ul>";
    rich = `<h3>${title}</h3><ul>` + (k.items || []).map((i) => `<li>${esc(i)}</li>`).join("") + "</ul>";
    plain = cardPlain(k);
  } else {
    body = String(k.body || "").trim();
    rich = `<h3>${title}</h3>${body}`;
    plain = cardPlain(k);
  }
  let media = "";
  if (t === "image") {
    media =
      `<figure class='shot'><img src='${imgSrc(k.img)}' alt='${title}' loading='lazy' draggable='true'>` +
      `<figcaption>Drag the image onto your board, or use the image pack.</figcaption></figure>`;
  }
  let buttons = `<button type='button' class='copy' data-target='${cid}'>Copy card</button>`;
  let urlrow = "";
  if (t === "link") {
    const u = esc(k.url);
    buttons =
      `<button type='button' class='copy' data-url='${u}'>Copy link</button>` +
      `<button type='button' class='copy ghost' data-target='${cid}'>Copy notes</button>`;
    urlrow = `<p class='url'><a href='${u}' target='_blank' rel='noopener'>${u.split("https://www.").join("").split("https://").join("")}</a></p>`;
  }
  return `
<article class="card card-${t}" id="${cid}-card">
  <div class="card-top"><span class="kind">${TYPE_LABEL[t]}</span><div class="btns">${buttons}</div></div>
  ${media}
  <div class="copy-src" id="${cid}" data-plain="${esc(plain)}" data-rich="${esc(rich)}">
    <h3>${title}</h3>
    ${urlrow}
    ${body}
  </div>
</article>`;
}

// The page body as the Artifact host received it (no <html>/<head> wrapper).
function renderFragment(kit, { imgSrc = defaultImgSrc } = {}) {
  const cols = kit.columns || [];
  const total = cols.reduce((n, c) => n + c.cards.length, 0);
  const nImg = cols.reduce((n, c) => n + c.cards.filter((k) => k.type === "image").length, 0);

  const sections = [];
  const nav = [];
  cols.forEach((c, i) => {
    const ci = i + 1;
    const color = COLOR_VAR[c.color];
    nav.push(
      `<a class='jump' href='#col${ci}'><span class='dot' style='--dot:var(--c-${color})'></span>${esc(c.name)}<span class='n'>${c.cards.length}</span></a>`
    );
    const cards = c.cards.map((k, j) => cardHtml(ci, j + 1, k, imgSrc)).join("");
    sections.push(`
<section class="column" id="col${ci}" aria-labelledby="col${ci}-h">
  <header class="col-head">
    <p class="col-meta"><span class="dot" style="--dot:var(--c-${color})"></span>Column ${ci} of ${cols.length} · Milanote color: ${c.color} · ${c.cards.length} cards</p>
    <h2 id="col${ci}-h">${esc(c.name)}</h2>
    <p class="col-lead">${esc(c.lead)}</p>
  </header>
  <div class="grid">${cards}</div>
</section>`);
  });

  const colnames = cols.map((c) => `<li>${esc(c.name)} <span class='muted'>(${c.color})</span></li>`).join("");

  return `<title>${esc(kit.title)}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&family=Playfair+Display:ital,wght@0,600;0,700;1,600&display=swap">
<style>${PAGE_CSS}</style>

<div class="wrap">
  <div class="intro">
    <div>
      <p class="eyebrow">${esc(kit.eyebrow)}</p>
      <h1>${esc(kit.title)}</h1>
      <p class="lead">${kit.lead_html}</p>
      <ul class="stats"><li><b>${cols.length}</b> columns</li><li><b>${total}</b> cards</li><li><b>${nImg}</b> drag-in images</li><li>${esc(kit.stats_label)}</li></ul>
    </div>
    <div class="howto">
      <h2>Load it into Milanote</h2>
      <ol>
        <li>Make a board called <b>${esc(kit.board_name)}</b> and add these columns, left to right, in their colors:
          <ul class="cols">${colnames}</ul></li>
        <li><b>Notes:</b> press <b>Copy card</b>, click into the column on your board, and paste.</li>
        <li><b>Links:</b> press <b>Copy link</b> and paste it; Milanote turns it into a preview card. Paste <b>Copy notes</b> under it.</li>
        <li><b>Images:</b> drag each template from this page onto the board, or drop the whole image pack in at once.</li>
        <li><b>To-do lists:</b> paste into a to-do card on shoot day, or into a note.</li>
      </ol>
    </div>
  </div>
</div>
<nav class="jumpbar" aria-label="Columns"><div class="wrap"><div class="jumps">${nav.join("")}</div></div></nav>
<main class="wrap">${sections.join("")}</main>
<footer class="wrap">
  <p>${kit.footer_html}</p>
</footer>
<div class="toast" id="toast" role="status" aria-live="polite" hidden></div>

<script>${PAGE_SCRIPT}</script>
`;
}

// A full document for serving from the app: the same page, plus an optional
// status bar (draft / approved / superseded) above it. `nonce` marks the page's
// own copy script so a Content-Security-Policy can refuse any other script.
function renderDocument(kit, { imgSrc = defaultImgSrc, banner = "", nonce = "" } = {}) {
  let frag = renderFragment(kit, { imgSrc });
  if (nonce) {
    const i = frag.lastIndexOf("\n<script>");
    if (i >= 0) frag = frag.slice(0, i) + `\n<script nonce="${esc(nonce)}">` + frag.slice(i + "\n<script>".length);
  }
  const bar = banner
    ? `\n<div class="kit-status" role="note" style="font:600 13px/1.4 var(--body);padding:10px 16px;background:var(--ink);color:var(--bg);text-align:center">${esc(banner)}</div>`
    : "";
  const at = frag.indexOf('\n<div class="wrap">');
  const body = at >= 0 ? frag.slice(0, at) + bar + frag.slice(at) : frag + bar;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<style>body{margin:0}</style>
${body}</html>
`;
}

const PAGE_CSS = `
/* Layout: a production binder that mirrors the Milanote board, one section per column, cards in a wrapping grid. */
:root {
  --bg: #eceff1; --surface: #ffffff; --ink: #14181c; --muted: #58616a; --line: #d3d9de; --chip: #f4f6f7;
  --accent: #00728c; --accent-ink: #ffffff; --focus: #00728c;
  --c-red: #c23f37; --c-blue: #2c5fc4; --c-purple: #7448bf; --c-yellow: #b08300; --c-orange: #c9631a;
  --c-green: #2c8550; --c-teal: #12807a; --c-grey: #78818a;
  --display: "Playfair Display", Georgia, "Times New Roman", serif;
  --body: "Archivo", "Helvetica Neue", Arial, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #111416; --surface: #1a1e21; --ink: #e8ecee; --muted: #9ba5ad; --line: #2b3136; --chip: #22272b;
  --accent: #3cc3de; --accent-ink: #04161b; --focus: #3cc3de;
  --c-red: #ef6b62; --c-blue: #6f98f0; --c-purple: #a687e6; --c-yellow: #e2b93a; --c-orange: #f0904a;
  --c-green: #5cc285; --c-teal: #45c2ba; --c-grey: #9aa3ab; color-scheme: dark; } }
:root[data-theme="dark"] {
  --bg: #111416; --surface: #1a1e21; --ink: #e8ecee; --muted: #9ba5ad; --line: #2b3136; --chip: #22272b;
  --accent: #3cc3de; --accent-ink: #04161b; --focus: #3cc3de;
  --c-red: #ef6b62; --c-blue: #6f98f0; --c-purple: #a687e6; --c-yellow: #e2b93a; --c-orange: #f0904a;
  --c-green: #5cc285; --c-teal: #45c2ba; --c-grey: #9aa3ab; color-scheme: dark; }
* { box-sizing: border-box; }
body { background: var(--bg); color: var(--ink); font: 400 15px/1.55 var(--body); }
body::before { content: ""; position: fixed; inset: 0 0 auto; height: env(safe-area-inset-top, 0px); z-index: 10; background: var(--bg); }
.wrap { max-width: 1240px; margin: 0 auto; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
a { color: var(--accent); }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.muted { color: var(--muted); }

.intro { padding-block: 48px 28px; display: grid; gap: 28px; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); align-items: start; }
.eyebrow { font: 500 12px/1.4 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin: 0 0 14px; }
h1 { font: 700 clamp(34px, 5vw, 56px)/1.04 var(--display); margin: 0 0 16px; text-wrap: balance; letter-spacing: -.01em; }
.lead { font-size: 17px; max-width: 60ch; margin: 0; }
.stats { display: flex; flex-wrap: wrap; gap: 8px 18px; margin: 18px 0 0; padding: 0; list-style: none; font: 500 13px/1.4 var(--mono); color: var(--muted); }
.stats b { color: var(--ink); font-weight: 500; }
.howto { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 20px 22px; }
.howto h2 { font: 600 13px/1.3 var(--mono); letter-spacing: .08em; text-transform: uppercase; margin: 0 0 12px; color: var(--muted); }
.howto ol { margin: 0; padding-left: 20px; display: grid; gap: 8px; }
.howto .cols { columns: 2; column-gap: 20px; margin: 10px 0 0; padding-left: 18px; font-size: 13.5px; }

.jumpbar { position: sticky; top: env(safe-area-inset-top, 0px); z-index: 5; background: var(--bg); border-bottom: 1px solid var(--line); }
.jumps { display: flex; gap: 6px; overflow-x: auto; padding-block: 10px; scrollbar-width: thin; }
.jump { flex: none; display: inline-flex; align-items: center; gap: 7px; padding: 6px 10px; border-radius: 999px; background: var(--surface); border: 1px solid var(--line); color: var(--ink); text-decoration: none; font: 500 13px/1 var(--body); }
.jump .n { font: 500 11px/1 var(--mono); color: var(--muted); }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--dot); display: inline-block; flex: none; }

.column { padding-block: 40px 8px; scroll-margin-top: 64px; }
.col-head { margin-bottom: 18px; }
.col-meta { display: flex; align-items: center; gap: 8px; font: 500 12px/1.4 var(--mono); color: var(--muted); letter-spacing: .03em; margin: 0 0 6px; }
.col-head h2 { font: 700 clamp(26px, 3.4vw, 34px)/1.1 var(--display); margin: 0 0 6px; text-wrap: balance; }
.col-lead { margin: 0; color: var(--muted); max-width: 70ch; }
.grid { columns: 330px; column-gap: 14px; }
.grid > .card { break-inside: avoid; margin-bottom: 14px; display: block; }

.card { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px 16px; min-width: 0; }
.card-top { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 8px; }
.kind { font: 500 11px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.btns { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.copy { font: 600 12.5px/1 var(--body); padding: 7px 11px; border-radius: 6px; border: 1px solid var(--accent); background: var(--accent); color: var(--accent-ink); cursor: pointer; }
.copy.ghost { background: transparent; color: var(--accent); }
.copy[data-state="done"] { background: var(--c-green); border-color: var(--c-green); color: var(--accent-ink); }
.copy-src h3 { font: 600 17px/1.3 var(--body); margin: 0 0 8px; text-wrap: balance; }
.copy-src p { margin: 0 0 9px; }
.copy-src ul, .copy-src ol { margin: 0 0 9px; padding-left: 20px; display: grid; gap: 5px; }
.copy-src code { font: 400 12.5px/1.5 var(--mono); background: var(--chip); padding: 1px 4px; border-radius: 3px; overflow-wrap: anywhere; }
.copy-src > *:last-child { margin-bottom: 0; }
.url { font: 400 12.5px/1.4 var(--mono); overflow-wrap: anywhere; }
.todo { list-style: none; padding-left: 0 !important; }
.todo li { display: grid; grid-template-columns: 16px 1fr; gap: 9px; align-items: start; }
.todo .box { width: 14px; height: 14px; border: 1.5px solid var(--muted); border-radius: 3px; margin-top: 4px; }
.shot { margin: 0 0 12px; }
.shot img { display: block; width: 100%; max-height: 460px; object-fit: contain; background: var(--chip); border: 1px solid var(--line); border-radius: 6px; cursor: grab; }
.shot figcaption { font: 400 12px/1.4 var(--mono); color: var(--muted); margin-top: 6px; }
.toast { position: fixed; left: 50%; transform: translateX(-50%); bottom: calc(16px + env(safe-area-inset-bottom, 0px)); background: var(--ink); color: var(--bg); padding: 10px 14px; border-radius: 8px; font: 500 13.5px/1.3 var(--body); max-width: calc(100% - 32px); z-index: 20; }
footer { padding-block: 40px 56px; color: var(--muted); font-size: 13.5px; }
@media (max-width: 760px) { .intro { grid-template-columns: 1fr; padding-block: 32px 20px; } .howto .cols { columns: 1; } }
@media (prefers-reduced-motion: no-preference) { html { scroll-behavior: smooth; } }
`;

const PAGE_SCRIPT = `
(function () {
  const toast = document.getElementById('toast');
  let tId;
  function say(msg) { toast.textContent = msg; toast.hidden = false; clearTimeout(tId); tId = setTimeout(() => { toast.hidden = true; }, 2200); }
  function mark(btn) { const old = btn.textContent; btn.dataset.state = 'done'; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = old; delete btn.dataset.state; }, 1600); }
  function selectNode(node) { const r = document.createRange(); r.selectNodeContents(node); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('button.copy'); if (!btn) return;
    let rich = null, plain = '', node = null;
    if (btn.dataset.url) { plain = btn.dataset.url; }
    else { node = document.getElementById(btn.dataset.target); rich = node.dataset.rich; plain = node.dataset.plain; }
    try {
      if (rich && window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
        await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([rich], { type: 'text/html' }), 'text/plain': new Blob([plain], { type: 'text/plain' }) })]);
      } else { throw new Error('no rich clipboard'); }
      mark(btn); say('Copied. Paste it onto your Milanote board.');
    } catch (err1) {
      try { await navigator.clipboard.writeText(plain); mark(btn); say('Copied as plain text. Paste it onto your board.'); }
      catch (err2) {
        if (node) { selectNode(node); say('Selected. Press Cmd+C or Ctrl+C, then paste.'); }
        else { say('Copy this link: ' + plain); }
      }
    }
  });
})();
`;

module.exports = { renderFragment, renderDocument, toText, cardPlain, esc, unescapeHtml, TYPE_LABEL, COLOR_VAR };
