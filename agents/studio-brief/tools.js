// Brief Writer tools — read the approved kits, look at links, and hand back
// one structured brief. Nothing here writes to a kit or the database: the
// brief is staged in memory and routes/studio-agents.js returns it to the
// person, who edits it, then starts a kit run with it (or doesn't).
//
// scope (set by the route, not the model):
//   { listApproved: () => [{ slug, title, version }],
//     approvedKit: (slug) => { slug, version, kit } | null,
//     slugTaken:   (slug) => boolean,
//     references:  [{ ref: "Image 1" | "Video 1" | "Link 1" | "File 1", kind, caption, url? }],
//     target:      { mode: "refresh" | "build" | "either", slug? },
//     onStage(stage) }

"use strict";

const { betaTool } = require("@anthropic-ai/sdk/helpers/beta/json-schema");
const K = require("../studio/kit");

const BRIEF_MIN = 120;
const BRIEF_MAX = 6000; // what a kit run accepts (agents/studio/service.js BRIEF_MAX)

const WEB_SEARCH = { type: "web_search_20250305", name: "web_search", max_uses: 6 };
const WEB_FETCH = { type: "web_fetch_20250910", name: "web_fetch", max_uses: 8, max_content_tokens: 6000 };

function json(x) {
  return JSON.stringify(x, null, 1);
}

function refused(msg, issues) {
  return `Refused: ${msg}` + (issues && issues.length ? `\n${issues.map((i) => `- ${i.where}: ${i.issue}`).join("\n")}` : "");
}

function toolsFor(ctx) {
  const scope = ctx && ctx.scope;
  if (!scope || typeof scope.approvedKit !== "function") throw new Error("brief tools need a run scope");
  const stage = { submitted: null, submits: 0 };
  if (typeof scope.onStage === "function") scope.onStage(stage);
  const refs = Array.isArray(scope.references) ? scope.references : [];

  const kitList = betaTool({
    name: "kit_list",
    description: "The approved kits a refresh can start from: slug, title, version. Call this first.",
    inputSchema: { type: "object", properties: {} },
    run: async () => json(await scope.listApproved()),
  });

  const kitOutline = betaTool({
    name: "kit_outline",
    description:
      "One approved kit's columns (name, color, lead) and every card title, with locked rule cards marked. Use the exact names in the brief so the kit agent knows which cards to touch.",
    inputSchema: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"] },
    run: async ({ slug }) => {
      const row = await scope.approvedKit(String(slug || ""));
      if (!row) return refused(`no approved kit "${slug}". Call kit_list.`);
      return json({
        slug: row.slug,
        version: row.version,
        title: row.kit.title,
        columns: row.kit.columns.map((c, i) => ({
          position: i + 1,
          name: c.name,
          color: c.color,
          lead: c.lead,
          cards: c.cards.map((k) => `${k.type}${k.locked ? " [locked]" : ""}: ${k.title}`),
        })),
      });
    },
  });

  const kitColumn = betaTool({
    name: "kit_read_column",
    description: "The full cards of one column of an approved kit, to see what it says today before you ask for a change.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string" }, column: { type: "string" } },
      required: ["slug", "column"],
    },
    run: async ({ slug, column }) => {
      const row = await scope.approvedKit(String(slug || ""));
      if (!row) return refused(`no approved kit "${slug}".`);
      const c = row.kit.columns.find((x) => x.name === column);
      if (!c) return refused(`no column "${column}". Columns: ${row.kit.columns.map((x) => x.name).join(" | ")}`);
      return json(c);
    },
  });

  const submit = betaTool({
    name: "submit_brief",
    description:
      "Hand back the finished brief. Call it once you're done (call again to replace it). Every reference Kyron gave must appear in `references`, with what it shows and what to take and leave. The brief is what the kit agent reads, and it never sees the images, so put what matters from them into words.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["refresh", "build"] },
        slug: { type: "string", description: "refresh: an approved kit's slug. build: a new short name (lower case, dashes)." },
        title: { type: "string", description: "A short name for this run, e.g. 'Add the Super 8 look'." },
        brief: { type: "string", description: `The brief, ${BRIEF_MIN}–${BRIEF_MAX} characters, in the format from the skill.` },
        needs_source: { type: "boolean", description: "build: true when the kit must be built from a playbook Kyron has to paste or load." },
        references: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ref: { type: "string", description: "Exactly as listed in the task: 'Image 1', 'Video 1', 'Link 2', 'File 1'." },
              what_it_shows: { type: "string" },
              take: { type: "string" },
              leave: { type: "string" },
              seen: { type: "string", enum: ["fully", "partly", "not loaded"] },
            },
            required: ["ref", "what_it_shows", "take", "seen"],
          },
        },
        questions: { type: "array", items: { type: "string" }, description: "Up to 5 things only Kyron can answer. Empty if none." },
      },
      required: ["mode", "slug", "title", "brief", "references"],
    },
    run: async (input) => {
      const issues = [];
      const mode = input.mode;
      const slug = String(input.slug || "").trim();
      const brief = String(input.brief || "").trim();
      if (!["refresh", "build"].includes(mode)) issues.push({ where: "mode", issue: "refresh or build" });
      if (!K.SLUG_RE.test(slug)) issues.push({ where: "slug", issue: "lower-case letters, numbers and dashes" });
      if (mode === "refresh" && K.SLUG_RE.test(slug) && !(await scope.approvedKit(slug))) {
        issues.push({ where: "slug", issue: `no approved kit "${slug}" to refresh; call kit_list` });
      }
      if (mode === "build" && K.SLUG_RE.test(slug) && (await scope.slugTaken(slug))) {
        issues.push({ where: "slug", issue: `"${slug}" already exists; refresh it, or pick a new name` });
      }
      if (brief.length < BRIEF_MIN) issues.push({ where: "brief", issue: `too short (under ${BRIEF_MIN} characters) for a kit agent to act on` });
      if (brief.length > BRIEF_MAX) issues.push({ where: "brief", issue: `over ${BRIEF_MAX} characters; tighten it` });
      const given = new Set(refs.map((r) => r.ref));
      const listed = Array.isArray(input.references) ? input.references : [];
      for (const r of listed) {
        if (!given.has(r.ref)) issues.push({ where: `references ${r.ref}`, issue: `not one of the references given (${[...given].join(", ") || "none"})` });
      }
      const covered = new Set(listed.map((r) => r.ref));
      const missing = [...given].filter((r) => !covered.has(r));
      if (missing.length) issues.push({ where: "references", issue: `say what you took from: ${missing.join(", ")}` });
      const questions = (Array.isArray(input.questions) ? input.questions : []).map((q) => String(q).trim()).filter(Boolean);
      if (questions.length > 5) issues.push({ where: "questions", issue: "five at most; keep the ones only Kyron can answer" });
      const text = [input.title, brief, ...listed.flatMap((r) => [r.what_it_shows, r.take, r.leave]), ...questions].join("\n");
      issues.push(...K.lintWords(text, "brief"));
      if (issues.length) return refused("fix these and submit again.", issues);
      stage.submits++;
      stage.submitted = {
        mode,
        slug,
        title: String(input.title || "").trim().slice(0, 120),
        brief,
        needs_source: !!input.needs_source,
        references: listed.map((r) => ({
          ref: r.ref,
          what_it_shows: String(r.what_it_shows || "").trim(),
          take: String(r.take || "").trim(),
          leave: String(r.leave || "").trim(),
          seen: r.seen,
        })),
        questions,
      };
      return `Submitted "${stage.submitted.title}" (${mode} ${slug}, ${brief.length} characters).`;
    },
  });

  return [kitList, kitOutline, kitColumn, submit, WEB_SEARCH, WEB_FETCH];
}

// The submitted brief as plain text (the run's output, and what the judge reads).
function briefText(b) {
  if (!b) return "";
  const lines = [`# ${b.title}`, `Mode: ${b.mode} · Kit: ${b.slug}${b.needs_source ? " · needs the playbook as source material" : ""}`, "", b.brief, ""];
  if (b.references.length) {
    lines.push("## What I took from your references");
    for (const r of b.references) {
      lines.push(`- ${r.ref} (${r.seen}): ${r.what_it_shows} Take: ${r.take}${r.leave ? ` Leave: ${r.leave}` : ""}`);
    }
    lines.push("");
  }
  if (b.questions.length) {
    lines.push("## Questions for you");
    b.questions.forEach((q) => lines.push(`- ${q}`));
  }
  return lines.join("\n").trim();
}

function evalView(result, stage, { idea = "", references = [] } = {}) {
  const given = references.map((r) => `- ${r.ref} (${r.kind})${r.url ? ` ${r.url}` : ""}${r.caption ? `: "${r.caption}"` : ""}`).join("\n") || "(none)";
  const b = stage && stage.submitted;
  const body = b ? `## The submitted brief\n${briefText(b)}` : "## The submitted brief\n(none)";
  return {
    ...result,
    output: `${result.output}\n\n---\n## What Kyron gave (banned words masked)\nIdea: ${K.maskBanned(idea)}\nReferences:\n${K.maskBanned(given)}\n\n${body}\n\n[brief] ${b ? "submitted" : "none"}`,
  };
}

module.exports = { toolsFor, evalView, briefText, BRIEF_MIN, BRIEF_MAX };
