// How the app sends email: a sending service over SMTP when it's set up,
// Gmail otherwise, and nothing (with the reason) when neither is.
//
//   node --test tests/mailer.test.js

const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");

const KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "EMAIL_USER", "EMAIL_PASS", "EMAIL_FROM", "EMAIL_REPLY_TO"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const mailer = require("../utils/mailer");

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  mailer.setSender(null);
});
after(() => {
  for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  mailer.setSender(null);
});

test("nothing set: nothing sent, and the caller hears why", async () => {
  assert.equal(mailer.configured(), false);
  assert.equal(mailer.mode(), null);
  assert.deepEqual(await mailer.sendMail({ to: "a@example.com", subject: "s", text: "t" }), { sent: false, reason: "email_not_configured" });
  assert.deepEqual(await mailer.sendMail({ to: [], subject: "s", text: "t" }), { sent: false, reason: "no_recipients" });
});

test("Gmail: EMAIL_USER and an app password, from that account", () => {
  process.env.EMAIL_USER = "subjectmedias@gmail.com";
  process.env.EMAIL_PASS = "app-password";
  assert.equal(mailer.mode(), "gmail");
  assert.deepEqual(mailer.transportOptions(), { service: "gmail", auth: { user: "subjectmedias@gmail.com", pass: "app-password" } });
  assert.equal(mailer.fromAddress(), "subjectmedias@gmail.com");
  process.env.EMAIL_FROM = "Subject Medias <subjectmedias@gmail.com>";
  assert.equal(mailer.fromAddress(), "Subject Medias <subjectmedias@gmail.com>");
});

test("a sending service: SMTP settings win over Gmail; 587 with STARTTLS, or 465", () => {
  process.env.EMAIL_USER = "subjectmedias@gmail.com";
  process.env.EMAIL_PASS = "app-password";
  process.env.SMTP_HOST = "smtp.postmarkapp.com";
  process.env.SMTP_USER = "server-token";
  process.env.SMTP_PASS = "server-token";
  assert.equal(mailer.mode(), "smtp");
  assert.deepEqual(mailer.transportOptions(), { host: "smtp.postmarkapp.com", port: 587, secure: false, requireTLS: true, auth: { user: "server-token", pass: "server-token" } });
  process.env.SMTP_PORT = "465";
  const o = mailer.transportOptions();
  assert.equal(o.port, 465);
  assert.equal(o.secure, true);
  assert.equal(o.requireTLS, false);
});

test("a sending service needs a sender it has verified: a token isn't an address", async () => {
  process.env.SMTP_HOST = "smtp.postmarkapp.com";
  process.env.SMTP_USER = "server-token";
  process.env.SMTP_PASS = "server-token";
  assert.equal(mailer.fromAddress(), "");
  assert.deepEqual(await mailer.sendMail({ to: "a@example.com", subject: "s", text: "t" }), { sent: false, reason: "no_sender" });
  process.env.SMTP_USER = "AKIAEXAMPLE";
  assert.equal(mailer.fromAddress(), "");
  process.env.SMTP_USER = "mailer@subjectmedias.com";
  assert.equal(mailer.fromAddress(), "mailer@subjectmedias.com");
  process.env.EMAIL_FROM = "Subject Medias <hello@subjectmedias.com>";
  assert.equal(mailer.fromAddress(), "Subject Medias <hello@subjectmedias.com>");
});

test("replies: the message's own address, else EMAIL_REPLY_TO; anything odd is dropped", async () => {
  const got = [];
  mailer.setSender(async (m) => { got.push(m); return { sent: true }; });
  await mailer.sendMail({ to: "A@Example.com", subject: "s", text: "t", replyTo: "Hello@SubjectMedias.com" });
  assert.deepEqual(got[0], { to: ["a@example.com"], subject: "s", text: "t", replyTo: "hello@subjectmedias.com" });
  process.env.EMAIL_REPLY_TO = "help@subjectmedias.com";
  await mailer.sendMail({ to: "a@example.com", subject: "s", text: "t" });
  assert.equal(got[1].replyTo, "help@subjectmedias.com");
  await mailer.sendMail({ to: "a@example.com", subject: "s", text: "t", replyTo: "x@y.com, thief@evil.example" });
  assert.ok(!("replyTo" in got[2]), "two addresses in one isn't an address");
  delete process.env.EMAIL_REPLY_TO;
  await mailer.sendMail({ to: "a@example.com", subject: "s", text: "t" });
  assert.ok(!("replyTo" in got[3]));
});
