// Campaign deal graph — the only data access the campaign routes and agent
// tools use. Every function takes a pg client (inside withActor) and a scope
// { tenant_id, campaign_id }, and every query is filtered by that scope, so a
// caller bound to one campaign can't read or write another.

const FINDING_KINDS = new Set([
  "value_mismatch", "stale", "cross_document", "arithmetic",
  "policy", "missing_disclosure", "unbound_claim", "banned_word",
]);
const SEVERITIES = new Set(["blocker", "major", "minor"]);
const FACT_KINDS = new Set([
  "party", "role", "offering", "price", "split", "fee",
  "obligation", "milestone", "constraint", "assumption", "disclosure",
]);
// Agents may only propose facts as 'proposed' or 'hypothetical'. A person
// marks a term agreed, signed, posted or measured.
const AGENT_FACT_STATUSES = new Set(["proposed", "hypothetical"]);
const FACT_STATUSES = new Set(["proposed", "agreed", "signed", "posted", "hypothetical", "measured"]);
const KEY_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// TOJ banned vocabulary (CLAUDE.md, TOJ-wide). Word-boundary, case-insensitive.
const BANNED_WORDS = [
  "elite", "generational", "next-level", "next level", "phenom", "future star",
  "premier", "top-notch", "top notch", "state-of-the-art", "state of the art",
  "revolutionize", "unlock", "unleash", "transform", "game-changing",
  "game changing", "supercharge",
];

function isUuid(v) {
  return typeof v === "string" && UUID_RE.test(v);
}

function bad(msg) {
  const e = new Error(msg);
  e.code = "bad_input";
  return e;
}

// ---- Reads -------------------------------------------------------------------

async function campaignHeader(c, scope) {
  const { rows } = await c.query(
    `select c.id, c.name, c.status, c.created_at,
            (select max(number) from deal.graph_versions g
              where g.campaign_id = c.id and g.approved_by is not null) as latest_approved,
            (select number from deal.graph_versions g
              where g.campaign_id = c.id and g.approved_by is null) as open_version
       from deal.campaigns c
      where c.id = $1 and c.tenant_id = $2`,
    [scope.campaign_id, scope.tenant_id]
  );
  return rows[0] || null;
}

async function versions(c, scope) {
  const { rows } = await c.query(
    `select id, number, summary, proposed_by, approved_by, approved_at, created_at,
            (select count(*)::int from deal.findings f
              where f.campaign_id = g.campaign_id and f.graph_version = g.number
                and f.status = 'open' and f.severity = 'blocker') as open_blockers
       from deal.graph_versions g
      where campaign_id = $1 and tenant_id = $2
      order by number`,
    [scope.campaign_id, scope.tenant_id]
  );
  return rows;
}

// Which version to read when none is named: the latest approved one, else
// the open proposal (a brand-new campaign has nothing approved yet).
async function defaultVersion(c, scope) {
  const h = await campaignHeader(c, scope);
  if (!h) return null;
  return h.latest_approved || h.open_version || null;
}

async function graphAt(c, scope, version) {
  const v = version ? Number(version) : await defaultVersion(c, scope);
  if (!v) return { version: null, facts: [] };
  if (!Number.isInteger(v) || v < 1) throw bad("version must be a positive whole number");
  const { rows } = await c.query(
    `select f.key, f.kind, f.value, f.status, f.source, f.from_version
       from deal.graph_at($1, $2) f
      where f.tenant_id = $3
      order by f.key`,
    [scope.campaign_id, v, scope.tenant_id]
  );
  return { version: v, facts: rows };
}

async function graphDiff(c, scope, from, to) {
  const a = Number(from), b = Number(to);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 1) throw bad("from and to must be version numbers");
  const owns = await campaignHeader(c, scope);
  if (!owns) return [];
  const { rows } = await c.query(`select * from deal.graph_diff($1, $2, $3)`, [scope.campaign_id, a, b]);
  return rows;
}

async function listDocuments(c, scope) {
  const { rows } = await c.query(
    `select d.id, d.kind, d.title, d.audience, d.origin,
            v.id as version_id, v.number as version_number, v.graph_version, v.status as version_status
       from deal.documents d
       left join lateral (
         select * from deal.document_versions dv
          where dv.document_id = d.id order by dv.number desc limit 1
       ) v on true
      where d.campaign_id = $1 and d.tenant_id = $2
      order by d.created_at`,
    [scope.campaign_id, scope.tenant_id]
  );
  return rows;
}

async function documentVersion(c, scope, versionId) {
  if (!isUuid(versionId)) return null;
  const { rows } = await c.query(
    `select v.id, v.document_id, v.number, v.graph_version, v.status, v.body,
            d.kind, d.title, d.audience
       from deal.document_versions v
       join deal.documents d on d.id = v.document_id
      where v.id = $1 and v.campaign_id = $2 and v.tenant_id = $3`,
    [versionId, scope.campaign_id, scope.tenant_id]
  );
  return rows[0] || null;
}

async function claimsFor(c, scope, versionId) {
  if (!isUuid(versionId)) return [];
  const { rows } = await c.query(
    `select id, locator, quote, fact_keys, stated, bound_by, confidence
       from deal.claims
      where version_id = $1 and campaign_id = $2 and tenant_id = $3
      order by created_at`,
    [versionId, scope.campaign_id, scope.tenant_id]
  );
  return rows;
}

async function findings(c, scope, { status = "open" } = {}) {
  const { rows } = await c.query(
    `select f.id, f.graph_version, f.version_id, f.kind, f.severity, f.fact_key, f.message, f.fix,
            f.status, f.raised_by, f.resolved_by, f.resolved_at, f.note, f.created_at,
            d.title as document_title
       from deal.findings f
       left join deal.document_versions v on v.id = f.version_id
       left join deal.documents d on d.id = v.document_id
      where f.campaign_id = $1 and f.tenant_id = $2 and ($3::text is null or f.status = $3)
      order by case f.severity when 'blocker' then 0 when 'major' then 1 else 2 end, f.created_at`,
    [scope.campaign_id, scope.tenant_id, status]
  );
  return rows;
}

// ---- Deterministic checks ----------------------------------------------------------

// One pattern per banned word; "next-level" and "next level" share one.
const BANNED_PATTERNS = (() => {
  const seen = new Map();
  for (const w of BANNED_WORDS) {
    const src = `\\b${w.replace(/[-\s]/g, "[-\\s]")}\\w*`;
    if (!seen.has(src)) seen.set(src, w);
  }
  return [...seen].map(([src, word]) => ({ word, src }));
})();

// Banned words with a line locator. Pure function — no database.
function lintVoice(body) {
  const hits = [];
  const lines = String(body || "").split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const { word, src } of BANNED_PATTERNS) {
      const re = new RegExp(src, "gi");
      while (re.exec(line)) {
        hits.push({ word, line: i + 1, quote: line.trim().slice(0, 200) });
      }
    }
  });
  return hits;
}

// ---- Validation for staged agent writes -----------------------------------------

function checkClaim(cl) {
  if (!cl || typeof cl !== "object") throw bad("each claim is an object");
  if (!cl.locator || typeof cl.locator !== "string") throw bad("claim.locator is required");
  if (!cl.quote || typeof cl.quote !== "string") throw bad("claim.quote is required");
  const keys = cl.fact_keys || [];
  if (!Array.isArray(keys) || keys.some((k) => !KEY_RE.test(k))) throw bad("claim.fact_keys must be fact keys");
  if (cl.confidence !== undefined && cl.confidence !== null) {
    const n = Number(cl.confidence);
    if (!(n >= 0 && n <= 1)) throw bad("claim.confidence is between 0 and 1");
  }
  return {
    locator: cl.locator.slice(0, 200),
    quote: cl.quote.slice(0, 2000),
    fact_keys: keys,
    stated: cl.stated === undefined ? null : cl.stated,
    confidence: cl.confidence === undefined ? null : Number(cl.confidence),
  };
}

function checkFinding(f) {
  if (!f || typeof f !== "object") throw bad("each finding is an object");
  if (!FINDING_KINDS.has(f.kind)) throw bad(`finding.kind must be one of: ${[...FINDING_KINDS].join(", ")}`);
  if (!SEVERITIES.has(f.severity)) throw bad("finding.severity is blocker, major or minor");
  if (!f.message || typeof f.message !== "string") throw bad("finding.message is required");
  if (f.fact_key && !KEY_RE.test(f.fact_key)) throw bad("finding.fact_key must be a fact key");
  if (f.version_id && !isUuid(f.version_id)) throw bad("finding.version_id must be a document version id");
  const claimIds = f.claim_ids || [];
  if (!Array.isArray(claimIds) || claimIds.some((x) => !isUuid(x))) throw bad("finding.claim_ids must be claim ids");
  return {
    kind: f.kind,
    severity: f.severity,
    message: f.message.slice(0, 2000),
    fix: f.fix ? String(f.fix).slice(0, 2000) : null,
    fact_key: f.fact_key || null,
    version_id: f.version_id || null,
    claim_ids: claimIds,
    graph_version: f.graph_version === undefined ? null : Number(f.graph_version),
  };
}

function checkFact(f, { agent }) {
  if (!f || typeof f !== "object") throw bad("each fact is an object");
  if (!KEY_RE.test(f.key || "")) throw bad("fact.key must look like split.pylon.event_sales");
  if (!FACT_KINDS.has(f.kind)) throw bad(`fact.kind must be one of: ${[...FACT_KINDS].join(", ")}`);
  const allowed = agent ? AGENT_FACT_STATUSES : FACT_STATUSES;
  if (!allowed.has(f.status)) throw bad(`fact.status must be one of: ${[...allowed].join(", ")}`);
  if (f.value === undefined) throw bad("fact.value is required");
  return { key: f.key, kind: f.kind, value: f.value, status: f.status, source: f.source ? String(f.source).slice(0, 300) : null };
}

// ---- Writes ---------------------------------------------------------------------------

async function insertClaims(c, scope, versionId, claims, actor) {
  const v = await documentVersion(c, scope, versionId);
  if (!v) throw bad("document version not found in this campaign");
  const ids = [];
  for (const raw of claims) {
    const cl = checkClaim(raw);
    const { rows } = await c.query(
      `insert into deal.claims (tenant_id, campaign_id, version_id, locator, quote, fact_keys, stated,
                                bound_by, confidence, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, 'extractor', $8, $9) returning id`,
      [scope.tenant_id, scope.campaign_id, versionId, cl.locator, cl.quote, cl.fact_keys,
       cl.stated === null ? null : JSON.stringify(cl.stated), cl.confidence, actor]
    );
    ids.push(rows[0].id);
  }
  return ids;
}

async function insertFindings(c, scope, list, actor) {
  const h = await campaignHeader(c, scope);
  if (!h) throw bad("campaign not found");
  const fallbackVersion = h.open_version || h.latest_approved;
  const ids = [];
  for (const raw of list) {
    const f = checkFinding(raw);
    const gv = f.graph_version || fallbackVersion;
    if (!gv) throw bad("the campaign has no graph version yet; propose one first");
    if (f.claim_ids.length) {
      const { rows } = await c.query(
        `select count(*)::int as n from deal.claims where id = any($1::uuid[]) and campaign_id = $2`,
        [f.claim_ids, scope.campaign_id]
      );
      if (rows[0].n !== f.claim_ids.length) throw bad("finding.claim_ids must be claims in this campaign");
    }
    const { rows } = await c.query(
      `insert into deal.findings (tenant_id, campaign_id, graph_version, version_id, kind, severity,
                                  claim_ids, fact_key, message, fix, raised_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [scope.tenant_id, scope.campaign_id, gv, f.version_id, f.kind, f.severity,
       f.claim_ids, f.fact_key, f.message, f.fix, actor]
    );
    ids.push(rows[0].id);
  }
  return ids;
}

// Add changes to the campaign's open proposed version (creating it if none is
// open). set: facts to add or replace; remove: keys to close.
async function proposeFacts(c, scope, { summary, set = [], remove = [] }, actor, { agent = false } = {}) {
  if (!summary || typeof summary !== "string") throw bad("summary is required");
  const facts = set.map((f) => checkFact(f, { agent }));
  for (const k of remove) if (!KEY_RE.test(k)) throw bad("remove takes fact keys");
  if (!facts.length && !remove.length) throw bad("nothing to propose");

  const h = await campaignHeader(c, scope);
  if (!h) throw bad("campaign not found");

  let n = h.open_version;
  if (!n) {
    const next = await c.query(
      `select coalesce(max(number), 0) + 1 as n from deal.graph_versions where campaign_id = $1`,
      [scope.campaign_id]
    );
    n = next.rows[0].n;
    await c.query(
      `insert into deal.graph_versions (tenant_id, campaign_id, number, summary, proposed_by)
       values ($1, $2, $3, $4, $5)`,
      [scope.tenant_id, scope.campaign_id, n, summary.slice(0, 500), actor]
    );
  } else {
    await c.query(
      `update deal.graph_versions set summary = left(summary || '; ' || $3, 2000)
        where campaign_id = $1 and number = $2 and approved_by is null`,
      [scope.campaign_id, n, summary.slice(0, 500)]
    );
  }

  async function current(key) {
    const { rows } = await c.query(
      `select id, from_version from deal.facts where campaign_id = $1 and key = $2 and to_version is null`,
      [scope.campaign_id, key]
    );
    return rows[0] || null;
  }

  for (const f of facts) {
    const cur = await current(f.key);
    if (cur && cur.from_version === n) {
      await c.query(
        `update deal.facts set kind = $2, value = $3, status = $4, source = $5 where id = $1`,
        [cur.id, f.kind, JSON.stringify(f.value), f.status, f.source]
      );
      continue;
    }
    if (cur) await c.query(`update deal.facts set to_version = $2 where id = $1`, [cur.id, n]);
    await c.query(
      `insert into deal.facts (tenant_id, campaign_id, key, kind, value, status, source, from_version)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [scope.tenant_id, scope.campaign_id, f.key, f.kind, JSON.stringify(f.value), f.status, f.source, n]
    );
  }
  for (const key of remove) {
    const cur = await current(key);
    if (!cur) continue;
    if (cur.from_version === n) await c.query(`delete from deal.facts where id = $1`, [cur.id]);
    else await c.query(`update deal.facts set to_version = $2 where id = $1`, [cur.id, n]);
  }
  return n;
}

// Commit what an agent staged during its accepted attempt.
async function commitStage(c, scope, stage, actor) {
  const out = { claims: 0, findings: 0, version: null };
  for (const [versionId, claims] of Object.entries(stage.claims || {})) {
    out.claims += (await insertClaims(c, scope, versionId, claims, actor)).length;
  }
  if (stage.facts && (stage.facts.set.length || stage.facts.remove.length)) {
    out.version = await proposeFacts(c, scope, stage.facts, actor, { agent: true });
  }
  if (stage.findings && stage.findings.length) {
    out.findings = (await insertFindings(c, scope, stage.findings, actor)).length;
  }
  return out;
}

module.exports = {
  campaignHeader,
  versions,
  graphAt,
  graphDiff,
  listDocuments,
  documentVersion,
  claimsFor,
  findings,
  lintVoice,
  checkClaim,
  checkFinding,
  checkFact,
  insertClaims,
  insertFindings,
  proposeFacts,
  commitStage,
  isUuid,
  BANNED_WORDS,
};
