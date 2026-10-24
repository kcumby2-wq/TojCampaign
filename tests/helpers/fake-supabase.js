// A small in-memory stand-in for the Supabase client: enough of the query
// builder for the routes under test (select/insert/update/upsert/delete with
// eq/neq/in/is/gt/gte/lt/lte/order/limit/range, single/maybeSingle, rpc, and
// upsert on one column or a comma-separated set). Not a database.
const crypto = require("crypto");

function fakeSupabase(seed = {}, { unique = {}, rpc = {} } = {}) {
  const tables = {};
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r }));
  const t = (name) => (tables[name] = tables[name] || []);

  class Q {
    constructor(name) {
      this.name = name;
      this.op = "select";
      this.filters = [];
      this.mode = "many";
      this.returning = false;
    }
    select() { if (this.op !== "select") this.returning = true; return this; }
    insert(rows) { this.op = "insert"; this.rows = [].concat(rows); return this; }
    upsert(rows, { onConflict } = {}) { this.op = "upsert"; this.rows = [].concat(rows); this.conflict = onConflict; return this; }
    update(patch) { this.op = "update"; this.patch = patch; return this; }
    delete() { this.op = "delete"; return this; }
    eq(c, v) { this.filters.push((r) => r[c] === v); return this; }
    neq(c, v) { this.filters.push((r) => r[c] !== v); return this; }
    in(c, vs) { this.filters.push((r) => vs.includes(r[c])); return this; }
    is(c, v) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
    gt(c, v) { this.filters.push((r) => r[c] > v); return this; }
    lt(c, v) { this.filters.push((r) => r[c] < v); return this; }
    gte(c, v) { this.filters.push((r) => r[c] >= v); return this; }
    lte(c, v) { this.filters.push((r) => r[c] <= v); return this; }
    range(from, to) { this.rng = [from, to]; return this; }
    order(c, { ascending = true } = {}) { this.ord = [c, ascending]; return this; }
    limit(n) { this.lim = n; return this; }
    single() { this.mode = "single"; return this; }
    maybeSingle() { this.mode = "maybe"; return this; }
    run() {
      const rows = t(this.name);
      const keys = unique[this.name] || [];
      if (this.op === "insert" || this.op === "upsert") {
        const out = [];
        for (const r of this.rows) {
          const cols = this.conflict ? String(this.conflict).split(",").map((c) => c.trim()) : [];
          const existing = cols.length ? rows.find((x) => cols.every((c) => x[c] === r[c])) : null;
          if (existing && this.op === "upsert") { Object.assign(existing, r); out.push(existing); continue; }
          if (keys.some((k) => rows.some((x) => x[k] === r[k]))) return { data: null, error: { code: "23505", message: "duplicate key" } };
          const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r };
          rows.push(row);
          out.push(row);
        }
        return this.finish(out);
      }
      let out = rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.op === "update") { out.forEach((r) => Object.assign(r, this.patch)); return this.returning ? this.finish(out) : { data: null, error: null }; }
      if (this.op === "delete") { tables[this.name] = rows.filter((r) => !out.includes(r)); return { data: null, error: null }; }
      if (this.ord) {
        const [c, asc] = this.ord;
        out = [...out].sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1));
      }
      if (this.rng) out = out.slice(this.rng[0], this.rng[1] + 1);
      if (this.lim) out = out.slice(0, this.lim);
      return this.finish(out);
    }
    finish(out) {
      const copy = JSON.parse(JSON.stringify(out));
      if (this.mode === "single") return copy.length === 1 ? { data: copy[0], error: null } : { data: null, error: { message: "not one row" } };
      if (this.mode === "maybe") return { data: copy[0] || null, error: null };
      return { data: copy, error: null };
    }
    then(res, rej) { return Promise.resolve().then(() => this.run()).then(res, rej); }
  }

  return {
    tables,
    from: (name) => new Q(name),
    rpc: async (fn, args) => (rpc[fn] ? rpc[fn](tables, args) : { data: null, error: { message: `no rpc ${fn}` } }),
  };
}

module.exports = { fakeSupabase };
