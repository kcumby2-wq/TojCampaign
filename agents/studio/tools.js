// Studio pack tools — built fresh for every run attempt.
//
// The agent never writes a kit anywhere. Every write lands in a per-attempt
// STAGE (an in-memory copy of the kit). routes/studio-agents.js saves the
// stage as a new DRAFT version only when the run finishes, and only a person
// can approve a draft. The approved kit is never edited in place.
//
// scope (set by the route, not the model):
//   { mode: "build" | "refresh",
//     slug,                      the kit's slug
//     assets,                    template image set ("same-work") or null
//     base: { id, version, kit } refresh: the approved kit the draft starts from
//     allow_locked,              true only if the person ticked "allow rule changes"
//     onStage(stage) }

"use strict";

const { betaTool } = require("@anthropic-ai/sdk/helpers/beta/json-schema");
const K = require("./kit");
const { cardPlain } = require("./kit-render");

const WEB_SEARCH = { type: "web_search_20250305", name: "web_search", max_uses: 10 };
const WEB_FETCH = { type: "web_fetch_20250910", name: "web_fetch", max_uses: 10, max_content_tokens: 8000 };

const CARD_SCHEMA = {
  type: "object",
  description:
    "One Milanote card. note: title + body (HTML). link: title + url + body (notes under the link). image: title + img (a template id from kit_templates) + body. todo: title + items (plain text).",
  properties: {
    type: { type: "string", enum: K.CARD_TYPES },
    title: { type: "string" },
    body: { type: "string", description: "Small HTML: <p>, <b>, <i>, <ul>/<ol>/<li>, <a href=\"https://...\">, <code>, <br>. Nothing else." },
    url: { type: "string" },
    img: { type: "string" },
    items: { type: "array", items: { type: "string" } },
    locked: { type: "boolean", description: "true for a rule card nobody may change without sign-off" },
  },
  required: ["type", "title"],
};

function json(x) {
  return JSON.stringify(x, null, 1);
}

function refused(msg, issues) {
  return `Refused: ${msg}` + (issues && issues.length ? `\n${issues.map((i) => `- ${i.where}: ${i.issue}`).join("\n")}` : "");
}

function newStage(scope) {
  const kit =
    scope.mode === "refresh"
      ? K.clone(scope.base.kit)
      : K.emptyKit(scope.slug, scope.assets || null);
  if (scope.mode === "refresh") {
    kit.version = null; // set when the draft is saved
  }
  const stage = {
    mode: scope.mode,
    base_id: scope.base ? scope.base.id : null,
    base_version: scope.base ? scope.base.version : null,
    allow_locked: !!scope.allow_locked,
    kit,
    ops: [],
  };
  // The approved kit, for diffs. Not enumerable, so it never gets saved twice.
  Object.defineProperty(stage, "base_kit", { value: scope.base ? scope.base.kit : null, enumerable: false });
  return stage;
}

function toolsFor(ctx) {
  const scope = ctx && ctx.scope;
  if (!scope || !["build", "refresh"].includes(scope.mode)) throw new Error("studio tools need a run scope");
  if (!K.SLUG_RE.test(String(scope.slug || ""))) throw new Error("studio tools need a kit slug");
  if (scope.mode === "refresh" && !(scope.base && scope.base.kit)) throw new Error("a refresh run needs the approved kit");

  const stage = newStage(scope);
  if (typeof scope.onStage === "function") scope.onStage(stage);
  const kit = stage.kit;
  const refresh = scope.mode === "refresh";
  const baseKit = refresh ? scope.base.kit : null;

  const col = (name) => kit.columns.find((c) => c.name === name);
  const colNames = () => kit.columns.map((c) => c.name);
  const lockedInBase = (column, title) => {
    if (!refresh) return false;
    const k = K.findCard(baseKit, column, title);
    return !!(k && k.locked);
  };
  const guardLocked = (column, title) =>
    lockedInBase(column, title) && !scope.allow_locked
      ? refused(`"${title}" is a locked rule card. Rule cards change only when the person who started the run allows rule changes. Leave it as it is and name the change you'd suggest in your summary.`)
      : null;
  const needReason = (reason) =>
    refresh && !(typeof reason === "string" && reason.trim().length >= 8)
      ? refused("say why in `reason` (the source or the brief line that calls for this change). Every change in a refresh is reviewed by a person.")
      : null;
  const log = (op) => {
    stage.ops.push({ ...op, at: stage.ops.length + 1 });
  };

  const overview = betaTool({
    name: "kit_overview",
    description:
      "The kit you're working on: mode (build or refresh), header fields, and every column with its color, lead and card titles (locked cards marked). Call this first.",
    inputSchema: { type: "object", properties: {} },
    run: async () =>
      json({
        mode: scope.mode,
        slug: kit.slug,
        base_version: stage.base_version,
        allow_rule_changes: !!scope.allow_locked,
        header: Object.fromEntries(K.META_FIELDS.map((f) => [f, kit[f]])),
        template_set: kit.assets,
        columns: kit.columns.map((c, i) => ({
          position: i + 1,
          name: c.name,
          color: c.color,
          lead: c.lead,
          cards: c.cards.map((k) => `${k.type}${k.locked ? " [locked]" : ""}: ${k.title}`),
        })),
        changes_so_far: stage.ops.length,
      }),
  });

  const readColumn = betaTool({
    name: "kit_read_column",
    description: "Every card in one column, in full (HTML bodies, urls, items). Read a column before you change anything in it.",
    inputSchema: {
      type: "object",
      properties: { column: { type: "string", description: "Column name, exactly as kit_overview lists it." } },
      required: ["column"],
    },
    run: async ({ column }) => {
      const c = col(column);
      if (!c) return refused(`no column "${column}". Columns: ${colNames().join(" | ") || "(none yet)"}`);
      return json(c);
    },
  });

  const templates = betaTool({
    name: "kit_templates",
    description:
      "The template images an image card may use (id, what it shows, aspect ratio). Image cards can only point at these; a new design needs a designer, so describe it in a note card instead.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const list = K.templatesFor(kit.assets);
      return list.length ? json(list) : "This kit has no template images. Describe any image a designer should make in a note card.";
    },
  });

  const setMeta = betaTool({
    name: "kit_set_meta",
    description:
      "Set the page header: title, eyebrow (one line above the title), lead_html (two sentences, may use <i>/<b>), board_name (what the Milanote board is called), stats_label (e.g. 'Rebuilt Oct 19, 2026'), footer_html (where it was rebuilt from and what's proposed). Only the fields you pass change.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        eyebrow: { type: "string" },
        lead_html: { type: "string" },
        board_name: { type: "string" },
        stats_label: { type: "string" },
        footer_html: { type: "string" },
        reason: { type: "string" },
      },
    },
    run: async (input = {}) => {
      const r = needReason(input.reason);
      if (r) return r;
      const next = { ...kit };
      const changed = [];
      for (const f of K.META_FIELDS) {
        if (typeof input[f] === "string" && input[f] !== kit[f]) {
          next[f] = input[f].trim();
          changed.push(f);
        }
      }
      if (!changed.length) return "Nothing changed.";
      const issues = K.checkMeta({ ...next, columns: [] }).filter((i) => i.level === "blocker" && changed.some((f) => i.where.includes(f) || i.where === "kit header"));
      if (issues.length) return refused("fix these first.", issues);
      for (const f of changed) kit[f] = next[f];
      log({ op: "set_meta", fields: changed, reason: input.reason || null });
      return `Set ${changed.join(", ")}.`;
    },
  });

  const putColumn = betaTool({
    name: "kit_put_column",
    description: refresh
      ? "Add a NEW column with all its cards (refresh runs can't replace an existing column; change existing cards one at a time with kit_put_card)."
      : "Write a whole column with all of its cards in one call: name, Milanote color, a one-line lead, and the cards in order. Writing a column that already exists replaces it.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        color: { type: "string", enum: K.COLORS },
        lead: { type: "string", description: "One line: what this column is for." },
        position: { type: "integer", minimum: 1, description: "Where the column goes, left to right. Leave out to add it at the end (or keep its place)." },
        cards: { type: "array", items: CARD_SCHEMA },
        reason: { type: "string" },
      },
      required: ["name", "color", "lead", "cards"],
    },
    run: async ({ name, color, lead, position, cards, reason }) => {
      const r = needReason(reason);
      if (r) return r;
      const existing = col(name);
      if (existing && refresh) return refused(`"${name}" already exists. In a refresh, change its cards one at a time with kit_put_card.`);
      if (!Array.isArray(cards) || !cards.length) return refused("a column needs its cards.");
      const out = [];
      const issues = [];
      const titles = new Set();
      for (const raw of cards) {
        const { card, issues: is } = K.checkCard(raw, { assets: kit.assets, where: `column "${name}"` });
        issues.push(...is.filter((i) => i.level === "blocker"));
        if (titles.has(card.title.toLowerCase())) issues.push({ where: `column "${name}"`, issue: `two cards titled "${card.title}"` });
        titles.add(card.title.toLowerCase());
        out.push(card);
      }
      issues.push(...K.checkColumnHeader(name, color, lead).filter((i) => i.level === "blocker"));
      if (cards.length > K.LIMITS.cardsPerColumn) issues.push({ where: `column "${name}"`, issue: `more than ${K.LIMITS.cardsPerColumn} cards; split the column` });
      if (!existing && kit.columns.length >= K.LIMITS.columns) issues.push({ where: "kit", issue: `the kit already has ${K.LIMITS.columns} columns` });
      if (issues.length) return refused("nothing was written. Fix these and send the column again.", dedupe(issues));
      const column = { name: String(name).trim(), color, lead: String(lead).trim(), cards: out };
      let at = existing ? kit.columns.indexOf(existing) : kit.columns.length;
      if (existing) kit.columns.splice(at, 1);
      if (Number.isInteger(position)) at = Math.max(0, Math.min(kit.columns.length, position - 1));
      kit.columns.splice(at, 0, column);
      log({ op: existing ? "replace_column" : "add_column", column: column.name, cards: out.length, reason: reason || null });
      return `${existing ? "Replaced" : "Added"} column "${column.name}" at position ${at + 1} with ${out.length} cards.`;
    },
  });

  const editColumn = betaTool({
    name: "kit_edit_column",
    description: "Change a column's name, color, lead or position without touching its cards.",
    inputSchema: {
      type: "object",
      properties: {
        column: { type: "string" },
        new_name: { type: "string" },
        color: { type: "string", enum: K.COLORS },
        lead: { type: "string" },
        position: { type: "integer", minimum: 1 },
        reason: { type: "string" },
      },
      required: ["column"],
    },
    run: async ({ column, new_name, color, lead, position, reason }) => {
      const r = needReason(reason);
      if (r) return r;
      const c = col(column);
      if (!c) return refused(`no column "${column}". Columns: ${colNames().join(" | ")}`);
      if (new_name && new_name !== c.name && col(new_name)) return refused(`a column called "${new_name}" already exists.`);
      if (refresh && new_name && new_name !== c.name && c.cards.some((k) => lockedInBase(c.name, k.title)) && !scope.allow_locked)
        return refused(`"${c.name}" holds locked rule cards; renaming it needs rule changes allowed.`);
      const w = K.checkColumnHeader(new_name || c.name, color || c.color, typeof lead === "string" && lead.trim() ? lead : c.lead).filter((i) => i.level === "blocker");
      if (w.length) return refused("nothing changed.", w);
      const changed = [];
      if (new_name && new_name !== c.name) {
        c.name = new_name.trim();
        changed.push("name");
      }
      if (color && color !== c.color) {
        c.color = color;
        changed.push("color");
      }
      if (typeof lead === "string" && lead.trim() && lead !== c.lead) {
        c.lead = lead.trim();
        changed.push("lead");
      }
      if (Number.isInteger(position)) {
        const from = kit.columns.indexOf(c);
        const to = Math.max(0, Math.min(kit.columns.length - 1, position - 1));
        if (from !== to) {
          kit.columns.splice(from, 1);
          kit.columns.splice(to, 0, c);
          changed.push("position");
        }
      }
      if (!changed.length) return "Nothing changed.";
      log({ op: "edit_column", column, changed, reason: reason || null });
      return `Column "${c.name}": changed ${changed.join(", ")}.`;
    },
  });

  const putCard = betaTool({
    name: "kit_put_card",
    description:
      "Add one card to a column, or replace a card. A card with the same title in that column is replaced in place; pass `replaces` to replace a card under a new title. `position` (1-based) places or moves it.",
    inputSchema: {
      type: "object",
      properties: {
        column: { type: "string" },
        card: CARD_SCHEMA,
        replaces: { type: "string", description: "Title of the card this one replaces, when the title changes." },
        position: { type: "integer", minimum: 1 },
        reason: { type: "string", description: "Refresh runs: why this changes (the source, or the line of the brief)." },
      },
      required: ["column", "card"],
    },
    run: async ({ column, card: raw, replaces, position, reason }) => {
      const r = needReason(reason);
      if (r) return r;
      const c = col(column);
      if (!c) return refused(`no column "${column}". Columns: ${colNames().join(" | ") || "(none yet: write a column first)"}`);
      const { card, issues } = K.checkCard(raw, { assets: kit.assets, where: `column "${column}"` });
      const blockers = issues.filter((i) => i.level === "blocker");
      if (blockers.length) return refused("nothing was written.", blockers);
      const targetTitle = replaces || card.title;
      const idx = c.cards.findIndex((k) => k.title === targetTitle);
      if (replaces && idx < 0) return refused(`no card titled "${replaces}" in "${column}".`);
      if (idx >= 0) {
        const g = guardLocked(column, c.cards[idx].title);
        if (g) return g;
        if (c.cards[idx].locked) card.locked = true; // a locked card stays locked
      }
      const clash = c.cards.findIndex((k, j) => j !== idx && k.title === card.title);
      if (clash >= 0) return refused(`"${column}" already has a card titled "${card.title}".`);
      if (idx < 0 && c.cards.length >= K.LIMITS.cardsPerColumn)
        return refused(`"${column}" already has ${K.LIMITS.cardsPerColumn} cards; put this in another column or replace a card.`);
      if (idx >= 0) c.cards.splice(idx, 1);
      let at = idx >= 0 ? idx : c.cards.length;
      if (Number.isInteger(position)) at = Math.max(0, Math.min(c.cards.length, position - 1));
      c.cards.splice(at, 0, card);
      const warn = issues.filter((i) => i.level === "warning");
      log({ op: idx >= 0 ? "replace_card" : "add_card", column, title: card.title, replaced: idx >= 0 ? targetTitle : null, reason: reason || null });
      return `${idx >= 0 ? "Replaced" : "Added"} "${card.title}" in "${column}" at ${at + 1}.` + (warn.length ? `\nWarnings: ${warn.map((w) => w.issue).join("; ")}` : "");
    },
  });

  const removeCard = betaTool({
    name: "kit_remove_card",
    description: "Remove one card from a column. Say why in `reason`.",
    inputSchema: {
      type: "object",
      properties: { column: { type: "string" }, title: { type: "string" }, reason: { type: "string" } },
      required: ["column", "title", "reason"],
    },
    run: async ({ column, title, reason }) => {
      const r = needReason(reason);
      if (r) return r;
      const c = col(column);
      if (!c) return refused(`no column "${column}".`);
      const idx = c.cards.findIndex((k) => k.title === title);
      if (idx < 0) return refused(`no card titled "${title}" in "${column}".`);
      const g = guardLocked(column, title);
      if (g) return g;
      if (c.cards.length === 1) return refused("that would leave the column empty; change the card instead.");
      c.cards.splice(idx, 1);
      log({ op: "remove_card", column, title, reason });
      return `Removed "${title}" from "${column}".`;
    },
  });

  const check = betaTool({
    name: "kit_check",
    description:
      "Check the whole kit the way the reviewer will: banned words, HTML a Milanote paste can't take, missing urls, unknown images, missing Sources card, duplicate titles. In a refresh it also lists what changed against the approved version. Run it before you finish and fix every blocker.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const r = K.checkKit(kit);
      const out = { ok: r.ok, counts: r.counts, blockers: r.blockers, warnings: r.warnings };
      if (refresh) {
        const d = K.diffKits(baseKit, kit);
        out.changes = { totals: d.totals, meta: d.meta.map((m) => m.field), columns: d.columns.filter((c) => c.status !== "same") };
      }
      return json(out);
    },
  });

  return [overview, readColumn, templates, setMeta, putColumn, editColumn, putCard, removeCard, check, WEB_SEARCH, WEB_FETCH];
}

function dedupe(issues) {
  const seen = new Set();
  return issues.filter((i) => {
    const k = `${i.where}|${i.issue}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// What the judge reads: the agent's summary, then the kit it staged
// (a build) or exactly what changed (a refresh), then the deterministic check.
function evalView(result, stage, { sourceExcerpt = "" } = {}) {
  if (!stage) return { ...result, output: `${result.output}\n\n[kit-check] blockers=1: nothing was staged` };
  const r = K.checkKit(stage.kit);
  const checkLine = `[kit-check] blockers=${r.blockers.length}${r.blockers.length ? ": " + r.blockers.slice(0, 8).map((b) => `${b.where}: ${b.issue}`).join(" | ") : ""}`;
  let body;
  if (stage.mode === "refresh") {
    const d = K.diffKits(stage.base_kit, stage.kit);
    const locked = [];
    for (const c of stage.base_kit.columns) {
      for (const k of c.cards) {
        if (!k.locked) continue;
        const now = K.findCard(stage.kit, c.name, k.title);
        locked.push(`- ${c.name} / ${k.title}: ${!now ? "REMOVED" : JSON.stringify(now) === JSON.stringify(k) ? "unchanged" : "CHANGED"}`);
      }
    }
    body = `## What changed against the approved kit (v${stage.base_version})\nEvery card not listed below is word-for-word the approved card.\n${K.diffText(stage.base_kit, stage.kit, d)}\n\n## Locked rule cards (rule changes ${stage.allow_locked ? "were" : "were NOT"} allowed on this run)\n${locked.join("\n") || "(none)"}\n\n## Change log (reasons the agent gave)\n${stage.ops.map((o) => `- ${o.op} ${o.column || ""} ${o.title ? `"${o.title}"` : ""}: ${o.reason || ""}`).join("\n") || "(no changes)"}`;
  } else {
    body = `## The kit the agent staged\n${K.kitText(stage.kit)}`;
    if (sourceExcerpt) body += `\n\n## Source material the kit was built from (excerpt; banned words masked)\n${K.maskBanned(sourceExcerpt)}`;
  }
  return { ...result, output: `${result.output}\n\n---\n${body}\n\n${checkLine}` };
}

module.exports = { toolsFor, evalView, newStage, WEB_SEARCH, WEB_FETCH, cardPlain };
