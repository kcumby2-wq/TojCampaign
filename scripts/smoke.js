// Smoke test — the guardrail that would have caught the pylon.js boot crash.
// Boots the real server on a test port (JSON fallback, no Supabase/Voyage
// needed), hits the load-bearing routes, asserts, and exits 0/1.
//
// Run: node scripts/smoke.js   (also `npm run smoke`, and in CI on every push)

const { spawn } = require("child_process");
const path = require("path");

const PORT = 3987;
const base = `http://localhost:${PORT}`;
const env = {
  ...process.env,
  PORT: String(PORT),
  SESSION_SECRET: process.env.SESSION_SECRET || "smoke-test-secret",
  REPORTS_ENABLED: "false",
  PYLON_CRON_ENABLED: "false",
};

const child = spawn(process.execPath, ["server.js"], {
  cwd: path.join(__dirname, ".."),
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForBoot(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (/running/i.test(out)) return;
    if (child.exitCode !== null) throw new Error("server exited during boot:\n" + out);
    await wait(200);
  }
  throw new Error("boot timeout after " + timeoutMs + "ms:\n" + out);
}

async function expect(label, promise, check) {
  const res = await promise;
  const ok = await check(res);
  if (!ok) throw new Error(label + " — unexpected: HTTP " + res.status);
  return res;
}

// Cross-platform teardown: set the exit code, kill the child, and let the
// event loop drain naturally. Calling process.exit() synchronously right after
// child.kill() trips a libuv assertion on Windows — this avoids it. A short
// unref'd backstop hard-exits only if the child somehow hangs.
function finish(code, msg) {
  if (msg) (code === 0 ? console.log : console.error)(msg);
  process.exitCode = code;
  try { child.kill(); } catch (e) {}
  setTimeout(() => process.exit(code), 3000).unref();
}

async function main() {
  try {
    await waitForBoot(20000);

    await expect("GET /api/health", fetch(base + "/api/health"), async (r) => {
      if (!r.ok) return false;
      const h = await r.json();
      return h.ok === true;
    });

    await expect(
      "POST /api/onboarding (public)",
      fetch(base + "/api/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audience: "coach",
          subject_name: "smoke",
          contact_email: "smoke@example.com",
          payload: { ci: true },
        }),
      }),
      (r) => r.status === 200
    );

    await expect(
      "GET /api/onboarding/list (must be auth-gated)",
      fetch(base + "/api/onboarding/list"),
      (r) => r.status === 401
    );

    await expect("GET /api/me", fetch(base + "/api/me"), (r) => r.ok);

    finish(0, "✅ SMOKE PASS — boot + /api/health + onboarding POST(200) + list(401) + me(200)");
  } catch (e) {
    finish(1, "❌ SMOKE FAIL: " + e.message);
  }
}
main();
