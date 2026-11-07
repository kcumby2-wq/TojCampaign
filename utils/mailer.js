"use strict";
// Email out of the app: staff alerts, and the notes bookers and families get.
//
// Two ways to send, picked by the settings on Render:
//   * A sending service over SMTP (Postmark, Amazon SES or any other):
//     SMTP_HOST, SMTP_USER and SMTP_PASS, with SMTP_PORT (587 unless set; 465
//     means TLS from the first byte, anything else upgrades with STARTTLS).
//     A service only sends from an address it has verified, so EMAIL_FROM
//     names it ("Subject Medias <hello@subjectmedias.com>"). Without a sender
//     the SMTP settings aren't used: mail stays on Gmail, if that's set up.
//   * Otherwise Gmail: EMAIL_USER and an app password in EMAIL_PASS, the same
//     pair the report emails use (utils/reportScheduler.js).
// Switching from Gmail to a service is only these settings: set the SMTP ones
// and EMAIL_FROM, and the next start sends through the service.
//
// A day's budget: Gmail stops an account that sends to more than 500
// recipients in a day, which would stop every email the app sends. So this
// counts recipients over the last 24 hours (MAIL_DAILY_LIMIT, 400 on Gmail and
// 5000 through a service unless set) and keeps the last sixth of it for mail
// that must go (critical: true, like a booking the database couldn't take).
// The count lives in memory, so a restart starts it again.
//
// EMAIL_REPLY_TO is where replies go when a message doesn't say. When nothing
// is set, nothing is sent and the caller hears why, so a missing setting never
// fails the work that sent it.

let transport = null;
let sender = null; // tests swap the whole send
let injected = null; // or just the transport, to test what's around it

const ADDRESS = /^[^\s@<>",;]+@[^\s@<>",;]+\.[a-z]{2,}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;
const env = (k) => String(process.env[k] || "").trim();
let sent = []; // [time, recipients]
let warned = false;

// SMTP counts only with a sender a service would take.
function smtpSender() {
  if (env("EMAIL_FROM")) return env("EMAIL_FROM");
  return ADDRESS.test(env("SMTP_USER")) ? env("SMTP_USER") : "";
}
function smtp() {
  return !!(env("SMTP_HOST") && env("SMTP_USER") && env("SMTP_PASS") && smtpSender());
}
function gmail() {
  return !!(env("EMAIL_USER") && env("EMAIL_PASS"));
}
function configured() {
  return smtp() || gmail();
}
// Which way mail goes, for the status checks: "smtp", "gmail" or null.
function mode() {
  return smtp() ? "smtp" : gmail() ? "gmail" : null;
}

// What nodemailer is given. Exported for the tests.
function transportOptions() {
  if (smtp()) {
    const port = Number(env("SMTP_PORT")) || 587;
    return {
      host: env("SMTP_HOST"),
      port,
      secure: port === 465,
      requireTLS: port !== 465,
      auth: { user: env("SMTP_USER"), pass: env("SMTP_PASS") },
    };
  }
  return { service: "gmail", auth: { user: env("EMAIL_USER"), pass: env("EMAIL_PASS") } };
}

// Who it's from: EMAIL_FROM, or the account's own address.
function fromAddress() {
  if (smtp()) return smtpSender();
  return env("EMAIL_FROM") || env("EMAIL_USER");
}

function dailyLimit() {
  const set = Number(env("MAIL_DAILY_LIMIT"));
  if (Number.isInteger(set) && set > 0) return set;
  return smtp() ? 5000 : 400;
}
// Room for this many more recipients today? Ordinary mail stops when five
// sixths of the day's budget is used; critical mail can use the rest.
function underBudget(n, critical, now = Date.now()) {
  sent = sent.filter(([t]) => now - t < DAY_MS);
  const used = sent.reduce((sum, [, k]) => sum + k, 0);
  const cap = critical ? dailyLimit() : Math.floor((dailyLimit() * 5) / 6);
  if (used + n > cap) return false;
  sent.push([now, n]);
  return true;
}

const plain = (e) => String(e || "").trim().toLowerCase();

async function sendMail({ to, subject, text, replyTo, critical = false }) {
  const list = [...new Set([].concat(to || []).filter(Boolean).map(plain))];
  if (!list.length) return { sent: false, reason: "no_recipients" };
  const reply = plain(replyTo || env("EMAIL_REPLY_TO"));
  const message = { to: list, subject, text };
  if (reply && ADDRESS.test(reply)) message.replyTo = reply;
  if (sender) return sender(critical ? { ...message, critical: true } : message);
  if (!configured()) {
    if (env("SMTP_HOST") && !smtpSender() && !warned) {
      warned = true;
      console.warn("[mailer] SMTP is set up without EMAIL_FROM: nothing to send from, so it isn't used");
    }
    return { sent: false, reason: "email_not_configured" };
  }
  if (!underBudget(list.length, critical)) return { sent: false, reason: "daily_limit" };
  const t = injected || (transport = transport || require("nodemailer").createTransport(transportOptions()));
  await t.sendMail({ from: fromAddress(), to: list.join(","), subject, text, ...(message.replyTo ? { replyTo: message.replyTo } : {}) });
  return { sent: true };
}

function setSender(fn) {
  sender = fn;
}
function setTransport(t) {
  injected = t;
  sent = [];
}

module.exports = { sendMail, configured, mode, setSender, setTransport, transportOptions, fromAddress, dailyLimit };
