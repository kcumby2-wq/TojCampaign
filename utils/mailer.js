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
// Ordinary mail also comes from a pool (bookings, market, fellowship,
// reports, other), and no pool may use more than 45% of the ordinary budget,
// so one busy public form can't stop everyone else's mail. A send that fails
// gives its place back. The count lives in memory, so a restart starts it
// again.
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
let sent = []; // [time, recipients, pool]
const POOL_SHARE = 0.45;
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
// Takes room for n more recipients today, or says no (null). Ordinary mail
// stops when five sixths of the day's budget is used, and a pool at 45% of
// that; critical mail can use the rest. Returns the way to give it back.
function reserve(n, { pool = "other", critical = false } = {}, now = Date.now()) {
  sent = sent.filter(([t]) => now - t < DAY_MS);
  const used = sent.reduce((sum, [, k]) => sum + k, 0);
  const ordinary = Math.floor((dailyLimit() * 5) / 6);
  if (used + n > (critical ? dailyLimit() : ordinary)) return null;
  if (!critical) {
    const mine = sent.reduce((sum, [, k, p]) => sum + (p === pool ? k : 0), 0);
    if (mine + n > Math.floor(ordinary * POOL_SHARE)) return null;
  }
  const entry = [now, n, critical ? "critical" : pool];
  sent.push(entry);
  return () => {
    const i = sent.indexOf(entry);
    if (i >= 0) sent.splice(i, 1);
  };
}

const plain = (e) => String(e || "").trim().toLowerCase();

async function sendMail({ to, subject, text, replyTo, critical = false, pool = "other" }) {
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
  const giveBack = reserve(list.length, { pool, critical });
  if (!giveBack) return { sent: false, reason: "daily_limit" };
  const t = injected || (transport = transport || require("nodemailer").createTransport(transportOptions()));
  try {
    await t.sendMail({ from: fromAddress(), to: list.join(","), subject, text, ...(message.replyTo ? { replyTo: message.replyTo } : {}) });
  } catch (e) {
    giveBack();
    throw e;
  }
  return { sent: true };
}

// What went wrong with an email, for the logs, without the addresses a mail
// server's error message can carry.
function errorCode(e) {
  return (e && (e.responseCode || e.code || e.name)) || "error";
}

function setSender(fn) {
  sender = fn;
}
function setTransport(t) {
  injected = t;
  sent = [];
}

module.exports = { sendMail, configured, mode, setSender, setTransport, transportOptions, fromAddress, dailyLimit, reserve, errorCode };
