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

test("the day's budget: ordinary mail stops at five sixths, each pool at 45% of that, critical mail uses the rest", async () => {
  gmail();
  process.env.MAIL_DAILY_LIMIT = "60"; // ordinary 50, a pool 22
  const send = (pool, n = 1, critical = false) => mailer.sendMail({ to: Array.from({ length: n }, (_, i) => `${pool}${i}-${Math.random()}@example.com`), subject: "s", text: "t", pool, critical });
  for (let i = 0; i < 22; i++) assert.equal((await send("bookings")).sent, true, "bookings " + i);
  assert.deepEqual(await send("bookings"), { sent: false, reason: "daily_limit" }, "one busy form stops at its share");
  assert.equal((await send("market")).sent, true, "the others still send");
  assert.equal((await send("market", 21)).sent, true);
  assert.equal((await send("fellowship", 6)).sent, true, "50 ordinary in all now");
  assert.deepEqual(await send("other"), { sent: false, reason: "daily_limit" });
  // Recipients count, not messages; critical mail can use the last sixth.
  assert.equal((await send("bookings", 2, true)).sent, true);
  assert.equal((await send("market", 8, true)).sent, true);
  assert.deepEqual(await send("bookings", 1, true), { sent: false, reason: "daily_limit" });
  assert.equal(mailer.dailyLimit(), 60);
  delete process.env.MAIL_DAILY_LIMIT;
  assert.equal(mailer.dailyLimit(), 400, "Gmail's 500, with room to spare");
  postmark();
  process.env.EMAIL_FROM = "hello@subjectmedias.com";
  assert.equal(mailer.dailyLimit(), 5000);
});

test("a send that fails gives its place back; outside senders can take a place too", async () => {
  gmail();
  process.env.MAIL_DAILY_LIMIT = "6"; // ordinary 5, a pool 2
  mailer.setTransport({ sendMail: async () => { throw Object.assign(new Error("550 5.1.1 <someone@example.com> no such user"), { responseCode: 550 }); } });
  for (let i = 0; i < 5; i++) await assert.rejects(mailer.sendMail({ to: "x@example.com", subject: "s", text: "t", pool: "bookings" }));
  mailer.setTransport({ sendMail: async (m) => { out.push(m); } });
  assert.equal((await mailer.sendMail({ to: "x@example.com", subject: "s", text: "t", pool: "bookings" })).sent, true, "five failures used nothing");
  assert.equal(mailer.errorCode(Object.assign(new Error("<someone@example.com> rejected"), { responseCode: 550 })), 550, "logs get the code, never the address");
  const giveBack = mailer.reserve(1, { pool: "reports" });
  assert.ok(giveBack);
  assert.ok(mailer.reserve(1, { pool: "reports" }));
  assert.equal(mailer.reserve(1, { pool: "reports" }), null, "reports have their share too");
  giveBack();
  assert.ok(mailer.reserve(1, { pool: "reports" }));
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
