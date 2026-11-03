"use strict";
// Staff email for alerts. Gmail through nodemailer, the same account the
// report emails use: EMAIL_USER and an app password in EMAIL_PASS
// (utils/reportScheduler.js). When they aren't set, nothing is sent and the
// caller hears why, so a missing setting never fails the work that sent it.

let transport = null;
let sender = null; // tests swap this

function configured() {
  return !!(process.env.EMAIL_USER && process.env.EMAIL_PASS);
}

async function sendMail({ to, subject, text }) {
  const list = [...new Set([].concat(to || []).filter(Boolean).map((e) => String(e).trim().toLowerCase()))];
  if (!list.length) return { sent: false, reason: "no_recipients" };
  if (sender) return sender({ to: list, subject, text });
  if (!configured()) return { sent: false, reason: "email_not_configured" };
  if (!transport) {
    transport = require("nodemailer").createTransport({
      service: "gmail",
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    });
  }
  await transport.sendMail({ from: process.env.EMAIL_FROM || process.env.EMAIL_USER, to: list.join(","), subject, text });
  return { sent: true };
}

function setSender(fn) {
  sender = fn;
}

module.exports = { sendMail, configured, setSender };
