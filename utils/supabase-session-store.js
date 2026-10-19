// Session store on Supabase — keeps sign-ins across Render restarts and
// deploys without a DATABASE_URL, through the service-role client the server
// already has (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).
//
// It uses public.session, the same table connect-pg-simple uses
// (sid varchar primary key, sess json, expire timestamp), so moving to
// DATABASE_URL later keeps everyone signed in. RLS is on with no policies, so
// only the service role can read it.
//
// Every request reads its session; a short in-process cache saves most of
// those round trips. Expiry is pushed forward at most once an hour per session,
// not on every request.

"use strict";

const session = require("express-session");

const CACHE_MS = 30 * 1000;
const TOUCH_EVERY_MS = 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function expiryOf(sess) {
  const c = sess && sess.cookie;
  if (c && c.expires) return new Date(c.expires);
  const ms = c && typeof c.maxAge === "number" ? c.maxAge : DEFAULT_TTL_MS;
  return new Date(Date.now() + ms);
}

// public.session.expire is "timestamp without time zone"; we always write UTC.
function toPg(d) {
  return d.toISOString().replace("Z", "");
}
function fromPg(s) {
  return new Date(String(s).endsWith("Z") ? s : `${s}Z`);
}

class SupabaseSessionStore extends session.Store {
  constructor({ client, table = "session", prune = true } = {}) {
    super();
    if (!client) throw new Error("SupabaseSessionStore needs a Supabase client");
    this.db = client;
    this.table = table;
    this.cache = new Map(); // sid -> { sess, expire: Date, at: ms, touchedAt: ms }
    if (prune) {
      this.pruneTimer = setInterval(() => this.prune().catch(() => {}), PRUNE_EVERY_MS);
      if (this.pruneTimer.unref) this.pruneTimer.unref();
    }
  }

  get(sid, cb) {
    const hit = this.cache.get(sid);
    if (hit && Date.now() - hit.at < CACHE_MS) {
      return cb(null, hit.expire > new Date() ? hit.sess : null);
    }
    this.db
      .from(this.table)
      .select("sess,expire")
      .eq("sid", sid)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) return cb(new Error(error.message));
        if (!data) {
          this.cache.delete(sid);
          return cb(null, null);
        }
        const expire = fromPg(data.expire);
        if (expire <= new Date()) {
          this.cache.delete(sid);
          return cb(null, null);
        }
        const sess = typeof data.sess === "string" ? JSON.parse(data.sess) : data.sess;
        this.cache.set(sid, { sess, expire, at: Date.now(), touchedAt: Date.now() });
        cb(null, sess);
      }, (e) => cb(e));
  }

  set(sid, sess, cb = () => {}) {
    const expire = expiryOf(sess);
    const plain = JSON.parse(JSON.stringify(sess));
    this.db
      .from(this.table)
      .upsert({ sid, sess: plain, expire: toPg(expire) }, { onConflict: "sid" })
      .then(({ error }) => {
        if (error) return cb(new Error(error.message));
        this.cache.set(sid, { sess: plain, expire, at: Date.now(), touchedAt: Date.now() });
        cb(null);
      }, (e) => cb(e));
  }

  destroy(sid, cb = () => {}) {
    this.cache.delete(sid);
    this.db
      .from(this.table)
      .delete()
      .eq("sid", sid)
      .then(({ error }) => cb(error ? new Error(error.message) : null), (e) => cb(e));
  }

  touch(sid, sess, cb = () => {}) {
    const hit = this.cache.get(sid);
    if (hit && Date.now() - hit.touchedAt < TOUCH_EVERY_MS) return cb(null);
    const expire = expiryOf(sess);
    this.db
      .from(this.table)
      .update({ expire: toPg(expire) })
      .eq("sid", sid)
      .then(({ error }) => {
        if (error) return cb(new Error(error.message));
        if (hit) Object.assign(hit, { expire, touchedAt: Date.now() });
        cb(null);
      }, (e) => cb(e));
  }

  async prune() {
    const { error } = await this.db.from(this.table).delete().lt("expire", toPg(new Date()));
    if (error) console.warn("[session] prune failed:", error.message);
  }

  close() {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
  }
}

module.exports = { SupabaseSessionStore, toPg, fromPg };
