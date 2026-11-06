// A small in-memory stand-in for Supabase Storage (supabase.storage): enough
// for the marketplace's routes and worker. Objects are bytes kept by key;
// signed links are fake https addresses on store.test, and `serve` answers a
// fetch of one the way Storage would. Not a storage server.
function fakeStorage() {
  const objects = new Map(); // "bucket/key" -> { bytes, contentType }
  const calls = [];
  const full = (bucket, key) => `${bucket}/${key}`;
  const from = (bucket) => ({
    async createSignedUploadUrl(key) {
      calls.push(["signUpload", key]);
      return { data: { signedUrl: `https://store.test/object/upload/sign/${bucket}/${key}?token=t-${calls.length}`, path: key, token: `t-${calls.length}` }, error: null };
    },
    async info(key) {
      const o = objects.get(full(bucket, key));
      return o ? { data: { name: key, size: o.bytes.length, contentType: o.contentType }, error: null } : { data: null, error: { message: "Object not found", statusCode: "404" } };
    },
    async createSignedUrl(key, seconds, opts = {}) {
      if (!objects.has(full(bucket, key))) return { data: null, error: { message: "Object not found" } };
      const dl = opts.download ? `&download=${encodeURIComponent(opts.download === true ? "" : opts.download)}` : "";
      return { data: { signedUrl: `https://store.test/object/sign/${bucket}/${key}?t=${seconds}${dl}` }, error: null };
    },
    async createSignedUrls(keys, seconds) {
      return {
        data: keys.map((k) => (objects.has(full(bucket, k)) ? { path: k, signedUrl: `https://store.test/object/sign/${bucket}/${k}?t=${seconds}`, error: null } : { path: k, signedUrl: null, error: "Object not found" })),
        error: null,
      };
    },
    async upload(key, body, opts = {}) {
      if (objects.has(full(bucket, key)) && !opts.upsert) return { data: null, error: { message: "The resource already exists" } };
      objects.set(full(bucket, key), { bytes: Buffer.from(body), contentType: opts.contentType || null });
      calls.push(["upload", key]);
      return { data: { path: key }, error: null };
    },
    async remove(keys) {
      for (const k of keys) objects.delete(full(bucket, k));
      calls.push(["remove", keys]);
      return { data: keys.map((name) => ({ name })), error: null };
    },
  });
  // As if the browser had uploaded a file on its signed link.
  const put = (bucket, key, bytes, contentType = null) => objects.set(full(bucket, key), { bytes: Buffer.from(bytes), contentType });
  const has = (bucket, key) => objects.has(full(bucket, key));
  const get = (bucket, key) => objects.get(full(bucket, key)) || null;
  // A fetch that answers this storage's signed links.
  async function serve(url) {
    const m = /^https:\/\/store\.test\/object\/sign\/([^/]+)\/([^?]+)/.exec(String(url));
    const o = m && objects.get(full(m[1], decodeURIComponent(m[2])));
    if (!o) return new Response("not found", { status: 404 });
    return new Response(o.bytes, { status: 200, headers: { "content-length": String(o.bytes.length) } });
  }
  return { objects, calls, from, put, has, get, serve };
}

module.exports = { fakeStorage };
