// A stand-in for the Supabase client backed by a real Postgres schema, so the
// routes run against the real migrations and their triggers (the in-memory
// fake in fake-supabase.js has no triggers). It covers the query-builder
// subset the routes use: select/insert/update/upsert/delete with
// eq/neq/in/is/gt/gte/lt/lte/order/limit/range, single/maybeSingle, and rpc.
// Each call is its own statement, as a PostgREST request is its own
// transaction; a bulk insert or upsert runs in one transaction.
//
// Test use only, on a throwaway database. makeSchema DROPS the schema it's
// given and builds it from the migrations.

const fs = require("fs");
const path = require("path");
const { Pool, types } = require("pg");

// The JSON shapes PostgREST returns.
types.setTypeParser(1082, (v) => v); // date
types.setTypeParser(1083, (v) => v); // time
types.setTypeParser(1184, (v) => v.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00")); // timestamptz, as 2026-10-24T01:30:00.123456+00:00
types.setTypeParser(1700, (v) => (v == null ? null : Number(v))); // numeric
types.setTypeParser(20, (v) => (v == null ? null : Number(v))); // int8

const MIGRATIONS = path.join(__dirname, "..", "..", "db", "migrations");

// A fresh schema with the team tables (019, 020) and Pylon events (024, 025),
// or the migrations named (to test the app before a migration has run).
const ALL = ["019_team.sql", "020_native_push.sql", "024_gfs_events.sql", "025_gfs_qr.sql"];
async function makeSchema(url, schema, files = ALL) {
  if (!/^gfs_[a-z0-9_]+_test$/.test(schema)) throw new Error("test schemas are named gfs_*_test");
  const admin = new Pool({ connectionString: url });
  await admin.query(`drop schema if exists ${schema} cascade; create schema ${schema};`);
  for (const r of ["anon", "authenticated", "service_role"])
    await admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${r}') then create role ${r} nologin; end if; end $$`);
  await admin.end();
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema} -c timezone=UTC`, max: 6 });
  // 019 adds a column to agent_runs (from an earlier migration).
  await pool.query(`create table ${schema}.agent_runs (id uuid primary key default gen_random_uuid())`);
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, file), "utf8").replace(/public\./g, `${schema}.`);
    await pool.query(sql);
  }
  return pool;
}

function pgSupabase(pool, schema) {
  const qi = (c) => '"' + String(c).replace(/"/g, '""') + '"';
  const T = (name) => `${schema}.${qi(name)}`;
  class Q {
    constructor(name) {
      this.name = name;
      this.op = "select";
      this.cols = "*";
      this.where = [];
      this.params = [];
      this.ords = [];
      this.mode = "many";
      this.returning = false;
    }
    p(v) {
      this.params.push(v);
      return "$" + this.params.length;
    }
    select(cols) {
      if (this.op === "select") this.cols = cols || "*";
      else this.returning = true;
      return this;
    }
    insert(rows) { this.op = "insert"; this.rows = [].concat(rows); return this; }
    upsert(rows, { onConflict } = {}) { this.op = "upsert"; this.rows = [].concat(rows); this.conflict = onConflict; return this; }
    update(patch) { this.op = "update"; this.patch = patch; return this; }
    delete() { this.op = "delete"; return this; }
    eq(c, v) { this.where.push(`${qi(c)} = ${this.p(v)}`); return this; }
    neq(c, v) { this.where.push(`${qi(c)} <> ${this.p(v)}`); return this; }
    in(c, vs) { this.where.push(`${qi(c)} = any(${this.p(vs)})`); return this; }
    is(c, v) { this.where.push(v === null ? `${qi(c)} is null` : `${qi(c)} is ${v ? "true" : "false"}`); return this; }
    gt(c, v) { this.where.push(`${qi(c)} > ${this.p(v)}`); return this; }
    gte(c, v) { this.where.push(`${qi(c)} >= ${this.p(v)}`); return this; }
    lt(c, v) { this.where.push(`${qi(c)} < ${this.p(v)}`); return this; }
    lte(c, v) { this.where.push(`${qi(c)} <= ${this.p(v)}`); return this; }
    order(c, { ascending = true } = {}) { this.ords.push(`${qi(c)} ${ascending ? "asc" : "desc"}`); return this; }
    range(a, b) { this.off = a; this.lim = b - a + 1; return this; }
    limit(n) { this.lim = n; return this; }
    single() { this.mode = "single"; return this; }
    maybeSingle() { this.mode = "maybe"; return this; }
    colList(c) { return !c || c === "*" ? "*" : String(c).split(",").map((x) => qi(x.trim())).join(","); }
    whereSql() { return this.where.length ? " where " + this.where.join(" and ") : ""; }
    async run() {
      const client = await pool.connect();
      try {
        if (this.op === "insert" || this.op === "upsert") {
          const out = [];
          await client.query("begin");
          try {
            for (const r of this.rows) {
              const keys = Object.keys(r);
              let sql = `insert into ${T(this.name)} (${keys.map(qi).join(",")}) values (${keys.map((_, i) => "$" + (i + 1)).join(",")})`;
              if (this.op === "upsert") {
                const cols = String(this.conflict).split(",").map((c) => c.trim());
                const set = keys.filter((k) => !cols.includes(k)).map((k) => `${qi(k)} = excluded.${qi(k)}`);
                sql += ` on conflict (${cols.map(qi).join(",")}) do ${set.length ? "update set " + set.join(",") : "nothing"}`;
              }
              const res = await client.query(sql + " returning *", keys.map((k) => r[k]));
              out.push(...res.rows);
            }
            await client.query("commit");
          } catch (e) {
            await client.query("rollback");
            throw e;
          }
          return this.finish(out);
        }
        if (this.op === "update") {
          const sets = Object.keys(this.patch).map((k) => `${qi(k)} = ${this.p(this.patch[k])}`);
          const res = await client.query(`update ${T(this.name)} set ${sets.join(",")}${this.whereSql()} returning *`, this.params);
          return this.returning || this.mode !== "many" ? this.finish(res.rows) : { data: null, error: null };
        }
        if (this.op === "delete") {
          await client.query(`delete from ${T(this.name)}${this.whereSql()}`, this.params);
          return { data: null, error: null };
        }
        let sql = `select ${this.colList(this.cols)} from ${T(this.name)}${this.whereSql()}`;
        if (this.ords.length) sql += " order by " + this.ords.join(",");
        if (this.lim !== undefined) sql += " limit " + Number(this.lim);
        if (this.off !== undefined) sql += " offset " + Number(this.off);
        return this.finish((await client.query(sql, this.params)).rows);
      } catch (e) {
        // What PostgREST returns: the SQLSTATE and the message (a trigger's
        // RAISE EXCEPTION text, for the rules migration 024 enforces).
        return { data: null, error: { code: e.code, message: e.message } };
      } finally {
        client.release();
      }
    }
    finish(rows) {
      const copy = JSON.parse(JSON.stringify(rows));
      if (this.mode === "single") return copy.length === 1 ? { data: copy[0], error: null } : { data: null, error: { code: "PGRST116", message: "not one row" } };
      if (this.mode === "maybe") return copy.length <= 1 ? { data: copy[0] || null, error: null } : { data: null, error: { code: "PGRST116", message: "many rows" } };
      return { data: copy, error: null };
    }
    then(res, rej) {
      return this.run().then(res, rej);
    }
  }
  return {
    from: (name) => new Q(name),
    rpc: async (fn, args) => {
      try {
        const keys = Object.keys(args || {});
        const res = await pool.query(`select * from ${schema}.${qi(fn)}(${keys.map((k, i) => `${qi(k)} => $${i + 1}`).join(",")})`, keys.map((k) => args[k]));
        return { data: JSON.parse(JSON.stringify(res.rows)), error: null };
      } catch (e) {
        return { data: null, error: { code: e.code, message: e.message } };
      }
    },
  };
}

module.exports = { makeSchema, pgSupabase };
