// Studio kits — the data shape, the checks, and the diff.
//
// A kit is one Milanote board written out as columns of cards, the way the
// Same Work kit was built on Oct 19, 2026 (kits/same-work.v1.json):
//
//   { schema, slug, version, as_of, title, eyebrow, lead_html, board_name,
//     stats_label, footer_html, assets, source, columns: [
//       { name, color, lead, cards: [
//         { type: "note",  title, body }            body = small HTML
//         { type: "link",  title, url, body }       url  = https only
//         { type: "image", title, img, body }       img  = a template id in assets/<set>/
//         { type: "todo",  title, items: [..] }     items = plain text
//         (any card may carry locked: true — see below)
//       ]}
//   ]}
//
// Locked cards are the rules (who owns what, the seven rules, minors on set,
// tools that may not touch footage, ...). A refresh run cannot change,
// remove or unlock them unless the person who started the run ticked
// "allow rule changes". Nothing here talks to the network or the database.

"use strict";

const fs = require("fs");
const path = require("path");
const { cardPlain, toText } = require("./kit-render");

const SCHEMA = "toj.studio.kit/v1";
const COLORS = ["Red", "Blue", "Purple", "Yellow", "Orange", "Green", "Teal", "Grey"];
const CARD_TYPES = ["note", "link", "image", "todo"];
const ALLOWED_TAGS = new Set(["p", "b", "i", "strong", "em", "ul", "ol", "li", "a", "code", "br"]);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

const LIMITS = {
  columns: 14,
  cardsPerColumn: 16,
  cards: 140,
  title: 120,
  body: 4000,
  bodyWarn: 1800,
  todoItems: 30,
  todoItem: 400,
  meta: 600,
};

// TOJ-wide banned vocabulary. "premier(?!e)" so Adobe Premiere Pro is fine.
const BANNED_RE =
  /\b(unlock\w*|unleash\w*|transform\w*|elite\w*|generational|next[- ]level|phenoms?|future\s+stars?|game[- ]chang\w*|supercharg\w*|premier(?!e)\w*|top[- ]notch|state[- ]of[- ]the[- ]art|revolutioni[sz]\w*)/gi;
const BANNED_PHRASES_RE = /\bguaranteed\s+(exposure|placement)\b/gi;

const KITS_DIR = path.join(__dirname, "kits");
const ASSETS_DIR = path.join(__dirname, "assets");

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

// ── Template images ──────────────────────────────────────────────────────
// assets/<set>/templates.json lists the images an image card may use.
const templateCache = new Map();
function templatesFor(set) {
  if (!set || !/^[a-z0-9-]+$/.test(set)) return [];
  if (templateCache.has(set)) return templateCache.get(set);
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, set, "templates.json"), "utf8"));
  } catch {
    list = [];
  }
  templateCache.set(set, list);
  return list;
}

function assetSets() {
  try {
    return fs.readdirSync(ASSETS_DIR).filter((d) => fs.existsSync(path.join(ASSETS_DIR, d, "templates.json")));
  } catch {
    return [];
  }
}

// ── Built-in kits (the approved baselines that ship in the repo) ─────────
function builtinId(kit) {
  return `builtin:${kit.slug}:v${kit.version}`;
}

let builtinCache = null;
function builtinKits() {
  if (builtinCache) return builtinCache;
  const out = [];
  for (const f of fs.readdirSync(KITS_DIR)) {
    if (!f.endsWith(".json")) continue;
    const kit = JSON.parse(fs.readFileSync(path.join(KITS_DIR, f), "utf8"));
    out.push({ id: builtinId(kit), slug: kit.slug, version: kit.version, status: "approved", builtin: true, title: kit.title, kit });
  }
  builtinCache = out;
  return out;
}

// ── HTML checks ──────────────────────────────────────────────────────────
function htmlIssues(html, where) {
  const issues = [];
  const s = String(html || "");
  const tagRe = /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g;
  const open = {};
  let m;
  while ((m = tagRe.exec(s))) {
    const closing = !!m[1];
    const tag = m[2].toLowerCase();
    const attrs = m[3].trim();
    if (!ALLOWED_TAGS.has(tag)) {
      issues.push({ level: "blocker", where, issue: `tag <${tag}> is not allowed (use p, b, i, ul, ol, li, a, code, br)` });
      continue;
    }
    if (!closing && tag === "a") {
      const ok = /^href="https:\/\/[^"\s<>]+"$/.test(attrs);
      if (!ok) issues.push({ level: "blocker", where, issue: `links must be exactly <a href="https://...">: got <a ${attrs}>` });
    } else if (attrs && attrs !== "/") {
      issues.push({ level: "blocker", where, issue: `<${tag}> may not carry attributes (${attrs.slice(0, 60)})` });
    }
    if (tag === "br") continue;
    open[tag] = (open[tag] || 0) + (closing ? -1 : 1);
  }
  for (const [tag, n] of Object.entries(open)) {
    if (n !== 0) issues.push({ level: "warning", where, issue: `<${tag}> opened and closed a different number of times` });
  }
  if (/javascript:|data:/i.test(s)) issues.push({ level: "blocker", where, issue: "no javascript: or data: URLs" });
  return issues;
}

function wordIssues(text, where) {
  const issues = [];
  const t = String(text || "");
  const words = [...new Set((t.match(BANNED_RE) || []).map((w) => w.toLowerCase()))];
  if (words.length) issues.push({ level: "blocker", where, issue: `banned word(s): ${words.join(", ")}. Say the concrete thing instead.` });
  const phrases = [...new Set((t.match(BANNED_PHRASES_RE) || []).map((w) => w.toLowerCase()))];
  if (phrases.length) issues.push({ level: "blocker", where, issue: `banned phrase(s): ${phrases.join(", ")}` });
  return issues;
}

function isHttpsUrl(u) {
  try {
    const x = new URL(String(u));
    return x.protocol === "https:" && !!x.hostname && !/\s/.test(String(u));
  } catch {
    return false;
  }
}

// Normalise one card and list what's wrong with it. Unknown fields are dropped.
function checkCard(input, { assets = null, where = "card" } = {}) {
  const issues = [];
  const k = input && typeof input === "object" ? input : {};
  const type = String(k.type || "");
  const card = { type, title: typeof k.title === "string" ? k.title.trim() : "" };
  const at = `${where} · "${card.title || "(untitled)"}"`;

  if (!CARD_TYPES.includes(type)) issues.push({ level: "blocker", where: at, issue: `type must be one of ${CARD_TYPES.join(", ")}` });
  if (!card.title) issues.push({ level: "blocker", where: at, issue: "every card needs a title" });
  if (card.title.length > LIMITS.title) issues.push({ level: "blocker", where: at, issue: `title is over ${LIMITS.title} characters` });
  if (/[<>]/.test(card.title)) issues.push({ level: "blocker", where: at, issue: "titles are plain text (no < or >)" });

  if (type === "todo") {
    const items = Array.isArray(k.items) ? k.items.map((i) => String(i).trim()).filter(Boolean) : [];
    card.items = items;
    if (!items.length) issues.push({ level: "blocker", where: at, issue: "a to-do card needs items" });
    if (items.length > LIMITS.todoItems) issues.push({ level: "blocker", where: at, issue: `more than ${LIMITS.todoItems} items; split the list` });
    for (const i of items) {
      if (i.length > LIMITS.todoItem) issues.push({ level: "blocker", where: at, issue: `an item is over ${LIMITS.todoItem} characters` });
      if (/<[a-z/]/i.test(i)) issues.push({ level: "blocker", where: at, issue: "to-do items are plain text, no HTML" });
    }
  } else {
    card.body = typeof k.body === "string" ? k.body.trim() : "";
    if (!card.body) issues.push({ level: "blocker", where: at, issue: "this card needs a body" });
    if (card.body.length > LIMITS.body) issues.push({ level: "blocker", where: at, issue: `body is over ${LIMITS.body} characters; split it into two cards` });
    else if (card.body.length > LIMITS.bodyWarn) issues.push({ level: "warning", where: at, issue: "long for one Milanote card; consider splitting" });
    if (card.body && !/^</.test(card.body)) issues.push({ level: "warning", where: at, issue: "start the body with a tag, e.g. <p>" });
    issues.push(...htmlIssues(card.body, at));
  }
  if (type === "link") {
    card.url = typeof k.url === "string" ? k.url.trim() : "";
    if (!isHttpsUrl(card.url)) issues.push({ level: "blocker", where: at, issue: "link cards need a full https:// url" });
  }
  if (type === "image") {
    card.img = typeof k.img === "string" ? k.img.trim() : "";
    const ids = templatesFor(assets).map((t) => t.id);
    if (!ids.includes(card.img)) {
      issues.push({
        level: "blocker",
        where: at,
        issue: ids.length
          ? `img must be one of the templates for this kit: ${ids.join(", ")}`
          : "this kit has no template images; use a note card that describes the image a designer should make",
      });
    }
  }
  if (k.locked === true) card.locked = true;

  const text = card.title + "\n" + (type === "todo" ? card.items.join("\n") : toText(card.body || ""));
  issues.push(...wordIssues(text, at));
  return { card, issues };
}

// as_of is set when a draft is saved (the day it was made), not by the agent.
const META_FIELDS = ["title", "eyebrow", "lead_html", "board_name", "stats_label", "footer_html"];

function checkMeta(kit) {
  const issues = [];
  if (kit.schema !== SCHEMA) issues.push({ level: "blocker", where: "kit", issue: `schema must be ${SCHEMA}` });
  if (!SLUG_RE.test(String(kit.slug || ""))) issues.push({ level: "blocker", where: "kit", issue: "slug must be lower-case letters, numbers and dashes" });
  for (const f of ["title", "eyebrow", "lead_html", "board_name", "stats_label", "footer_html"]) {
    const v = kit[f];
    if (typeof v !== "string" || !v.trim()) issues.push({ level: "blocker", where: `kit.${f}`, issue: "required" });
    else if (v.length > LIMITS.meta) issues.push({ level: "blocker", where: `kit.${f}`, issue: `over ${LIMITS.meta} characters` });
  }
  for (const f of ["title", "eyebrow", "board_name", "stats_label"]) {
    if (/[<>]/.test(String(kit[f] || ""))) issues.push({ level: "blocker", where: `kit.${f}`, issue: "plain text only" });
  }
  issues.push(...htmlIssues(kit.lead_html, "kit.lead_html"), ...htmlIssues(kit.footer_html, "kit.footer_html"));
  const metaText = ["title", "eyebrow", "board_name", "stats_label"].map((f) => kit[f] || "").join("\n") +
    "\n" + toText(kit.lead_html || "") + "\n" + toText(kit.footer_html || "");
  issues.push(...wordIssues(metaText, "kit header"));
  if (kit.assets && !assetSets().includes(kit.assets)) issues.push({ level: "blocker", where: "kit.assets", issue: `unknown template set "${kit.assets}"` });
  return issues;
}

function checkColumnHeader(name, color, lead) {
  const where = `column "${name}"`;
  const issues = [];
  if (!name || typeof name !== "string" || !name.trim()) issues.push({ level: "blocker", where, issue: "column needs a name" });
  else if (name.length > LIMITS.title || /[<>]/.test(name)) issues.push({ level: "blocker", where, issue: "column names are short plain text" });
  if (!COLORS.includes(color)) issues.push({ level: "blocker", where, issue: `color must be one of ${COLORS.join(", ")}` });
  if (!lead || typeof lead !== "string" || !lead.trim()) issues.push({ level: "blocker", where, issue: "column needs a one-line lead" });
  else if (lead.length > LIMITS.meta || /[<>]/.test(lead)) issues.push({ level: "blocker", where, issue: "the lead is one plain-text line" });
  issues.push(...wordIssues(`${name || ""}\n${lead || ""}`, where));
  return issues;
}

// Mask banned words in text the judge reads but the kit doesn't publish
// (the source playbook), so the vocabulary auto-fail only fires on our words.
function maskBanned(text) {
  return String(text || "").replace(BANNED_RE, "[banned word]").replace(BANNED_PHRASES_RE, "[banned phrase]");
}

// The whole kit: everything a person needs fixed before approving it.
function checkKit(kit) {
  const issues = [...checkMeta(kit || {})];
  const cols = Array.isArray(kit && kit.columns) ? kit.columns : [];
  if (!cols.length) issues.push({ level: "blocker", where: "kit", issue: "no columns yet" });
  if (cols.length > LIMITS.columns) issues.push({ level: "blocker", where: "kit", issue: `more than ${LIMITS.columns} columns` });
  const names = new Set();
  let total = 0;
  let locked = 0;
  let images = 0;
  let sources = false;
  for (const c of cols) {
    const where = `column "${c.name}"`;
    issues.push(...checkColumnHeader(c.name, c.color, c.lead));
    if (names.has(String(c.name).toLowerCase())) issues.push({ level: "blocker", where, issue: "two columns share this name" });
    names.add(String(c.name).toLowerCase());
    const cards = Array.isArray(c.cards) ? c.cards : [];
    if (!cards.length) issues.push({ level: "blocker", where, issue: "empty column" });
    if (cards.length > LIMITS.cardsPerColumn) issues.push({ level: "blocker", where, issue: `more than ${LIMITS.cardsPerColumn} cards; split the column` });
    const titles = new Set();
    for (const k of cards) {
      const r = checkCard(k, { assets: kit.assets, where });
      issues.push(...r.issues);
      const t = String(k.title || "").toLowerCase();
      if (titles.has(t)) issues.push({ level: "blocker", where, issue: `two cards are titled "${k.title}"` });
      titles.add(t);
      total++;
      if (k.locked) locked++;
      if (k.type === "image") images++;
      if (/^sources\b/i.test(String(k.title || ""))) sources = true;
    }
  }
  if (total > LIMITS.cards) issues.push({ level: "blocker", where: "kit", issue: `more than ${LIMITS.cards} cards` });
  if (cols.length && !sources) issues.push({ level: "blocker", where: "kit", issue: 'no "Sources" card: every kit ends with one, listing each outside source and the date it was checked' });
  if (cols.length && !locked) issues.push({ level: "warning", where: "kit", issue: "no locked rule cards: mark the rules nobody breaks with locked: true" });
  const blockers = issues.filter((i) => i.level === "blocker");
  return {
    ok: blockers.length === 0,
    blockers,
    warnings: issues.filter((i) => i.level === "warning"),
    counts: { columns: cols.length, cards: total, images, locked },
  };
}

// ── Diff ─────────────────────────────────────────────────────────────────
function cardKey(k) {
  return JSON.stringify([k.type, k.title, k.body || null, k.url || null, k.img || null, k.items || null, !!k.locked]);
}

function diffKits(base, next) {
  const out = { meta: [], columns: [], totals: { added: 0, removed: 0, changed: 0, same: 0, moved: 0 } };
  const b = base || { columns: [] };
  for (const f of META_FIELDS) {
    if ((b[f] || "") !== (next[f] || "")) out.meta.push({ field: f, before: b[f] || "", after: next[f] || "" });
  }
  const bCols = new Map((b.columns || []).map((c, i) => [c.name, { c, i }]));
  const nCols = new Map((next.columns || []).map((c, i) => [c.name, { c, i }]));
  for (const [name, { c, i }] of nCols) {
    const prev = bCols.get(name);
    if (!prev) {
      out.columns.push({ name, status: "added", position: i + 1, added: c.cards.map((k) => k.title), removed: [], changed: [], same: 0 });
      out.totals.added += c.cards.length;
      continue;
    }
    const header = [];
    if (prev.c.color !== c.color) header.push("color");
    if (prev.c.lead !== c.lead) header.push("lead");
    if (prev.i !== i) header.push("position");
    const bCards = new Map(prev.c.cards.map((k, j) => [k.title, { k, j }]));
    const nCards = new Map(c.cards.map((k, j) => [k.title, { k, j }]));
    const added = [];
    const removed = [];
    const changed = [];
    let same = 0;
    let moved = 0;
    for (const [t, { k, j }] of nCards) {
      const p = bCards.get(t);
      if (!p) added.push(t);
      else if (cardKey(p.k) !== cardKey(k)) changed.push(t);
      else {
        same++;
        if (p.j !== j) moved++;
      }
    }
    for (const t of bCards.keys()) if (!nCards.has(t)) removed.push(t);
    const status = added.length || removed.length || changed.length || header.length || moved ? "changed" : "same";
    out.columns.push({ name, status, position: i + 1, header, added, removed, changed, same, moved });
    out.totals.added += added.length;
    out.totals.removed += removed.length;
    out.totals.changed += changed.length;
    out.totals.same += same;
    out.totals.moved += moved;
  }
  for (const [name, { c }] of bCols) {
    if (!nCols.has(name)) {
      out.columns.push({ name, status: "removed", added: [], removed: c.cards.map((k) => k.title), changed: [], same: 0 });
      out.totals.removed += c.cards.length;
    }
  }
  out.unchanged = out.meta.length === 0 && out.columns.every((c) => c.status === "same");
  return out;
}

function findCard(kit, column, title) {
  const c = (kit.columns || []).find((x) => x.name === column);
  return c ? (c.cards || []).find((k) => k.title === title) || null : null;
}

// ── Text views for the judge ─────────────────────────────────────────────
function kitText(kit) {
  const lines = [`# ${kit.title} (${kit.slug} v${kit.version || "draft"})`, `Board: ${kit.board_name}`, toText(kit.lead_html || ""), ""];
  (kit.columns || []).forEach((c, i) => {
    lines.push(`## Column ${i + 1}: ${c.name} (${c.color}) — ${c.lead}`);
    for (const k of c.cards) {
      lines.push(`### [${k.type}${k.locked ? ", locked" : ""}] ${cardPlain(k)}`);
      if (k.url) lines.push(`URL: ${k.url}`);
      if (k.img) lines.push(`Image template: ${k.img}`);
      lines.push("");
    }
  });
  lines.push(`Footer: ${toText(kit.footer_html || "")}`);
  return lines.join("\n");
}

function diffText(base, next, diff = diffKits(base, next)) {
  const lines = [
    `Totals: ${diff.totals.changed} changed, ${diff.totals.added} added, ${diff.totals.removed} removed, ${diff.totals.same} untouched.`,
  ];
  for (const m of diff.meta) lines.push(`\n[header ${m.field}]\nBEFORE: ${m.before}\nAFTER: ${m.after}`);
  for (const c of diff.columns) {
    if (c.status === "same") continue;
    lines.push(`\n## ${c.name}: ${c.status}${c.header && c.header.length ? ` (column ${c.header.join(", ")} changed)` : ""}`);
    for (const t of c.changed) {
      const before = findCard(base, c.name, t);
      const after = findCard(next, c.name, t);
      lines.push(`\n### CHANGED: ${t}\nBEFORE:\n${cardPlain(before)}${before.url ? `\nURL: ${before.url}` : ""}\nAFTER:\n${cardPlain(after)}${after.url ? `\nURL: ${after.url}` : ""}`);
    }
    for (const t of c.added) {
      const after = findCard(next, c.name, t);
      lines.push(`\n### ADDED: ${t}\n${cardPlain(after)}${after.url ? `\nURL: ${after.url}` : ""}`);
    }
    for (const t of c.removed) lines.push(`\n### REMOVED: ${t}`);
  }
  return lines.join("\n");
}

function emptyKit(slug, assets = null) {
  return {
    schema: SCHEMA,
    slug,
    version: null,
    as_of: null,
    title: "",
    eyebrow: "",
    lead_html: "",
    board_name: "",
    stats_label: "",
    footer_html: "",
    assets,
    source: null,
    columns: [],
  };
}

module.exports = {
  SCHEMA,
  COLORS,
  CARD_TYPES,
  SLUG_RE,
  LIMITS,
  BANNED_RE,
  META_FIELDS,
  clone,
  templatesFor,
  assetSets,
  builtinKits,
  builtinId,
  checkCard,
  checkMeta,
  checkColumnHeader,
  checkKit,
  maskBanned,
  lintWords: wordIssues,
  diffKits,
  diffText,
  kitText,
  findCard,
  emptyKit,
  ASSETS_DIR,
};
