// The taste library (migration 041, routes/studio-taste.js) as the Brief
// Writer and Three Directions read it: notes on work worth learning from,
// each with a link, cited as "Taste 12". Read-only: an agent never adds to it.
//
// scope.searchTaste(query, tag) → rows, newest or best first
// scope.tasteByRef(n)           → the row with that ref_no, or null

"use strict";

const { betaTool } = require("@anthropic-ai/sdk/helpers/beta/json-schema");

const REF_RE = /^Taste (\d{1,7})$/;
const tasteRef = (row) => `Taste ${row.ref_no}`;
// What an agent reads of a note: every card's name as a code (scope.maskTaste).
const view = (row, mask = (x) => x) => ({ ref: tasteRef(row), title: mask(row.title), url: row.url, kind: row.kind, note: mask(row.note), take: row.take ? mask(row.take) : null, leave: row.leave ? mask(row.leave) : null, tags: row.tags || [] });

function tasteSearchTool(scope) {
  return betaTool({
    name: "taste_search",
    description:
      "Search the team's taste library: notes on films, cuts, looks, sounds, graphics and captions worth learning from, each with a link and what to take from it. Words find any form of the word ('grain' finds 'grainy'); a tag narrows it; no words gives the newest. Cite an entry as 'Taste 12'.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, tag: { type: "string" } } },
    run: async ({ query, tag }) => {
      if (typeof scope.searchTaste !== "function") return "The taste library isn't set up yet: carry on without it.";
      const rows = await scope.searchTaste(String(query || "").slice(0, 200), tag ? String(tag).toLowerCase().trim().slice(0, 24) : null);
      if (!rows || !rows.length) return "Nothing in the taste library for that. Try other words, or none for the newest.";
      const mask = typeof scope.maskTaste === "function" ? scope.maskTaste : (x) => x;
      return JSON.stringify(rows.slice(0, 12).map((r) => view(r, mask)), null, 1);
    },
  });
}

// The entries a submission cites, checked: { cited: [view], issues }.
async function checkCited(scope, refs, where) {
  const issues = [];
  const cited = [];
  const list = Array.isArray(refs) ? refs : [];
  if (list.length > 8) issues.push({ where, issue: "eight taste notes at most" });
  for (const r of list.slice(0, 8)) {
    const ref = String((r && r.ref) || r || "").trim();
    const m = REF_RE.exec(ref);
    const row = m && typeof scope.tasteByRef === "function" ? await scope.tasteByRef(Number(m[1])) : null;
    if (!row || row.archived_at) {
      issues.push({ where, issue: `no taste note "${ref}": cite one taste_search returned, as "Taste 12"` });
      continue;
    }
    // Kept with what cites it: the note's ref, title and link, and the use made of it.
    if (!cited.some((c) => c.ref === ref)) cited.push({ ref, title: row.title, url: row.url, use: String((r && r.take) || "").trim().slice(0, 300) || null });
  }
  return { cited, issues };
}

module.exports = { tasteSearchTool, checkCited, tasteRef, view, REF_RE };
