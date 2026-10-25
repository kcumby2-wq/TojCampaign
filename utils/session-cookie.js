// The sign-in cookie's settings, shared by server.js and its test.
//
// httpOnly keeps page scripts from reading it, and Secure ("auto") means it
// is only sent back over HTTPS whenever the request came in over HTTPS.
// Requests reach the app through Render's proxy (and Vercel's rewrite before
// that), so the app trusts one proxy hop to learn the connection was HTTPS.
// "auto" rather than true: if that header were ever missing, sign-in would
// keep working (without the flag) instead of silently failing.

const WEEK_MS = 1000 * 60 * 60 * 24 * 7;
const TRUST_PROXY_HOPS = 1;

function sessionCookie() {
  return { maxAge: WEEK_MS, httpOnly: true, secure: "auto" };
}

module.exports = { sessionCookie, TRUST_PROXY_HOPS, WEEK_MS };
