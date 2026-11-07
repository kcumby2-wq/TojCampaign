// The sign-in cookie's settings, shared by server.js and its test.
//
// httpOnly keeps page scripts from reading it, and Secure ("auto") means it
// is only sent back over HTTPS whenever the request came in over HTTPS.
// Requests reach the app through Render's proxy (and Vercel's rewrite before
// that), so the app trusts one proxy hop to learn the connection was HTTPS.
// "auto" rather than true: if that header were ever missing, sign-in would
// keep working (without the flag) instead of silently failing.
//
// sameSite "lax": the browser sends it when someone opens the app or follows
// a link to it, but never with a request another site starts (a form on
// another page posting here, an image or frame there). So no other site can
// act as a signed-in person on any route. Safari and Firefox send a cookie
// without the setting on another site's form posts, and Chrome does for two
// minutes after sign-in. Nothing here needs more: people sign in with the
// app's own form (no outside sign-in posts them back), the iPhone app loads
// tojcampaign.com itself, and the tools the app frames are its own pages.

const WEEK_MS = 1000 * 60 * 60 * 24 * 7;
const TRUST_PROXY_HOPS = 1;

function sessionCookie() {
  return { maxAge: WEEK_MS, httpOnly: true, secure: "auto", sameSite: "lax" };
}

module.exports = { sessionCookie, TRUST_PROXY_HOPS, WEEK_MS };
