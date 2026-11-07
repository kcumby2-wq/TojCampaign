"use strict";
// Email out of the app: staff alerts, and the notes bookers and families get.
//
// Two ways to send, picked by the settings on Render:
//   * A sending service over SMTP (Postmark, Amazon SES or any other):
//     SMTP_HOST, SMTP_USER and SMTP_PASS, with SMTP_PORT (587 unless set; 465
//     means TLS from the first byte, anything else upgrades with STARTTLS).
//     A service only sends from an address it has verified, so EMAIL_FROM
//     names it ("Subject Medias <hello@subjectmedias.com>").
//   * Otherwise Gmail: EMAIL_USER and an app password in EMAIL_PASS, the same
//     pair the report emails use (utils/reportScheduler.js).
// Switching from Gmail to a service is only these settings: set the SMTP ones
// and EMAIL_FROM, and the next start sends through the service.
//
// EMAIL_REPLY_TO is where replies go when a message doesn't say. When nothing
// is set, nothing is sent and the caller hears why, so a missing setting never
// fails the work that sent it.

let transport = null;
let sender = null; // tests swap this

const ADDRESS = /^[^\s@<>",;]+@[^\s@<>",;]+\.[a-z]{2,}$/i;
const env = (k) => String(process.env[k] || "").trim();

function smtp() {
  return !!(env("SMTP_HOST") && env("SMTP_USER") && env("SMTP_PASS"));
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

// Who it's from: EMAIL_FROM, or the account's own address. A service's SMTP
// user is often a token, not an address, so it only counts when it is one.
function fromAddress() {
  if (env("EMAIL_FROM")) return env("EMAIL_FROM");
  if (smtp()) return ADDRESS.test(env("SMTP_USER")) ? env("SMTP_USER") : "";
  return env("EMAIL_USER");
}

const plain = (e) => String(e || "").trim().toLowerCase();

async function sendMail({ to, subject, text, replyTo }) {
  const list = [...new Set([].concat(to || []).filter(Boolean).map(plain))];
  if (!list.length) return { sent: false, reason: "no_recipients" };
  const reply = plain(replyTo || env("EMAIL_REPLY_TO"));
  const message = { to: list, subject, text };
  if (reply && ADDRESS.test(reply)) message.replyTo = reply;
  if (sender) return sender(message);
  if (!configured()) return { sent: false, reason: "email_not_configured" };
  const from = fromAddress();
  if (!from) return { sent: false, reason: "no_sender" };
  if (!transport) transport = require("nodemailer").createTransport(transportOptions());
  await transport.sendMail({ from, to: list.join(","), subject, text, ...(message.replyTo ? { replyTo: message.replyTo } : {}) });
  return { sent: true };
}

function setSender(fn) {
  sender = fn;
}

module.exports = { sendMail, configured, mode, setSender, transportOptions, fromAddress };
