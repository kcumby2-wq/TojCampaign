// How the app sends email: a sending service over SMTP when it's set up,
// Gmail otherwise, nothing (with the reason) when neither is, and never past
// the day's budget.
//
//   node --test tests/mailer.test.js

const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");

const KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "EMAIL_USER", "EMAIL_PASS", "EMAIL_FROM", "EMAIL_REPLY_TO", "MAIL_DAILY_LIMIT"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const mailer = require("../utils/mailer");
let out;

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  mailer.setSender(null);
  out = [];
  mailer.setTransport({ sendMail: async (m) => { out.push(m); } });
});
after(() => {
  for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  mailer.setSender(null);
  mailer.setTransport(null);
});
const postmark = () => {
  process.env.SMTP_HOST = "smtp.postmarkapp.com";
  process.env.SMTP_USER = "server-token";
  process.env.SMTP_PASS = "server-token";
};
const gmail = () => {
  process.env.EMAIL_USER = "subjectmedias@gmail.com";
  process.env.EMAIL_PASS = "app-password";
};

test("nothing set: nothing sent, and the caller hears why", async () => {
  assert.equal(mailer.configured(), false);
  assert.equal(mailer.mode(), null);
  assert.deepEqual(await mailer.sendMail({ to: "a@example.com", subject: "s", text: "t" }), { sent: false, reason: "email_not_configured" });
  assert.deepEqual(await mailer.sendMail({ to: [], subject: "s", text: "t" }), { sent: false, reason: "no_recipients" });
  assert.equal(out.length, 0);
});

test("Gmail: EMAIL_USER and an app password, from that account", async () => {
  gmail();
  assert.equal(mailer.mode(), "gmail");
  assert.deepEqual(mailer.transportOptions(), { service: "gmail", auth: { user: "subjectmedias@gmail.com", pass: "app-password" } });
  assert.equal(mailer.fromAddress(), "subjectmedias@gmail.com");
  assert.deepEqual(await mailer.sendMail({ to: "A@Example.com", subject: "s", text: "t" }), { sent: true });
  assert.equal(out[0].from, "subjectmedias@gmail.com");
  assert.equal(out[0].to, "a@example.com");
  process.env.EMAIL_FROM = "Subject Medias <subjectmedias@gmail.com>";
  assert.equal(mailer.fromAddress(), "Subject Medias <subjectmedias@gmail.com>");
});

test("a sending service: with a sender it wins over Gmail; 587 with STARTTLS, or 465", async () => {
  gmail();
  postmark();
  process.env.EMAIL_FROM = "Subject Medias <hello@subjectmedias.com>";
  assert.equal(mailer.mode(), "smtp");
  assert.deepEqual(mailer.transportOptions(), { host: "smtp.postmarkapp.com", port: 587, secure: false, requireTLS: true, auth: { user: "server-token", pass: "server-token" } });
  await mailer.sendMail({ to: "a@example.com", subject: "s", text: "t" });
  assert.equal(out[0].from, "Subject Medias <hello@subjectmedias.com>");
  process.env.SMTP_PORT = "465";
  const o = mailer.transportOptions();
  assert.equal(o.port, 465);
  assert.equal(o.secure, true);
  assert.equal(o.requireTLS, false);
});

test("a service without a sender isn't used: mail stays on Gmail, or doesn't pretend to go", async () => {
  postmark();
  assert.equal(mailer.configured(), false, "a token isn't an address to send from");
  assert.deepEqual(await mailer.sendMail({ to: "a@example.com", subject: "s", text: "t" }), { sent: false, reason: "email_not_configured" });
  gmail();
  assert.equal(mailer.mode(), "gmail");
  assert.deepEqual(mailer.transportOptions().service, "gmail");
  await mailer.sendMail({ to: "a@example.com", subject: "s", text: "t" });
  assert.equal(out[0].from, "subjectmedias@gmail.com");
  // An SMTP user that is an address is a sender.
  delete process.env.EMAIL_USER;
  process.env.SMTP_USER = "mailer@subjectmedias.com";
  assert.equal(mailer.mode(), "smtp");
  assert.equal(mailer.fromAddress(), "mailer@subjectmedias.com");
});

test("the day's budget: ordinary mail stops at five sixths, critical mail can use the rest", async () => {
  gmail();
  process.env.MAIL_DAILY_LIMIT = "12";
  for (let i = 0; i < 10; i++) assert.equal((await mailer.sendMail({ to: `a${i}@example.com`, subject: "s", text: "t" })).sent, true, String(i));
  assert.deepEqual(await mailer.sendMail({ to: "b@example.com", subject: "s", text: "t" }), { sent: false, reason: "daily_limit" });
  // Recipients count, not messages: two at once need two places.
  assert.equal((await mailer.sendMail({ to: ["c@example.com", "d@example.com"], subject: "s", text: "t", critical: true })).sent, true);
  assert.deepEqual(await mailer.sendMail({ to: "e@example.com", subject: "s", text: "t", critical: true }), { sent: false, reason: "daily_limit" });
  assert.equal(out.length, 11);
  assert.equal(mailer.dailyLimit(), 12);
  delete process.env.MAIL_DAILY_LIMIT;
  assert.equal(mailer.dailyLimit(), 400, "Gmail's 500, with room to spare");
  postmark();
  process.env.EMAIL_FROM = "hello@subjectmedias.com";
  assert.equal(mailer.dailyLimit(), 5000);
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
  await mailer.sendMail({ to: "a@example.com", subject: "s", text: "t", critical: true });
  assert.equal(got[4].critical, true);
});
