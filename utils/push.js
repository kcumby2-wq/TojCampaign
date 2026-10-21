// Notifications to the TOJ app on phones and laptops.
//
// Two kinds of device in public.push_subscriptions (migrations 019, 020):
//   web   the Home Screen / browser app, through web push (below)
//   apns  the App Store iPhone app, through Apple (utils/apns.js)
//
// Keys: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY from the environment when set;
// otherwise the app makes a key pair once and keeps it in public.app_config
// (service-role only). Subscriptions live in public.push_subscriptions, one
// row per device that turned notifications on.
//
// Payloads carry kit names and links into the app only: never an athlete's
// name, contact or film link.

"use strict";

const { getSupabase } = require("./supabase");
const { staffEmails } = require("./staff");
const { ROLE_RANK } = require("./team");
const apns = require("./apns");

let webpush = null;
let keysPromise = null;
let sender = null; // tests swap this

function lib() {
  if (!webpush) webpush = require("web-push");
  return webpush;
}

async function vapidKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  if (keysPromise) return keysPromise;
  keysPromise = (async () => {
    const sb = getSupabase();
    if (!sb) throw new Error("no_database_for_push_keys");
    const read = async () => {
      const { data } = await sb.from("app_config").select("value").eq("key", "vapid").maybeSingle();
      return data && data.value && data.value.publicKey ? data.value : null;
    };
    const have = await read();
    if (have) return have;
    const made = lib().generateVAPIDKeys();
    // Two servers starting at once: the first insert wins; everyone reads it back.
    await sb.from("app_config").insert({ key: "vapid", value: made });
    return (await read()) || made;
  })();
  keysPromise.catch(() => {
    keysPromise = null;
  });
  return keysPromise;
}

async function send(sub, payload) {
  if (sender) return sender(sub, payload);
  if (sub.kind === "apns") return apns.deliver(sub, payload);
  const keys = await vapidKeys();
  return lib().sendNotification(
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
    JSON.stringify(payload),
    {
      TTL: 60 * 60 * 24,
      vapidDetails: { subject: process.env.VAPID_SUBJECT || "https://www.tojcampaign.com", publicKey: keys.publicKey, privateKey: keys.privateKey },
    }
  );
}

// payload: { title, body, url, tag?, badge? }
async function notify(emails, payload) {
  const list = [...new Set((emails || []).filter(Boolean).map((e) => String(e).toLowerCase()))];
  if (!list.length) return { sent: 0 };
  const sb = getSupabase();
  if (!sb) return { sent: 0 };
  const { data: subs, error } = await sb.from("push_subscriptions").select("id,email,endpoint,p256dh,auth,fail_count,kind,apns_env").in("email", list);
  if (error || !subs || !subs.length) return { sent: 0 };
  let sent = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        const r = await send(s, payload);
        sent++;
        const ok = { last_ok_at: new Date().toISOString(), fail_count: 0 };
        if (s.kind === "apns" && r && r.env && r.env !== s.apns_env) ok.apns_env = r.env;
        await sb.from("push_subscriptions").update(ok).eq("id", s.id);
      } catch (e) {
        // The server's Apple key isn't set yet: keep the device and wait.
        if (e && e.message === "apns_not_configured") return;
        const gone = e && (e.statusCode === 404 || e.statusCode === 410);
        if (gone || (s.fail_count || 0) >= 4) await sb.from("push_subscriptions").delete().eq("id", s.id);
        else await sb.from("push_subscriptions").update({ fail_count: (s.fail_count || 0) + 1 }).eq("id", s.id);
      }
    })
  );
  return { sent };
}

// Everyone on the team at or above a role (owners always included).
async function teamEmails(minRole = "viewer", tool = "studio") {
  const out = new Set(staffEmails());
  const sb = getSupabase();
  if (!sb) return [...out];
  const { data } = await sb.from("team_members").select("email,role,tools,status").eq("status", "active");
  for (const m of data || []) {
    if (ROLE_RANK[m.role] >= ROLE_RANK[minRole] && (!tool || (m.tools || []).includes(tool))) out.add(m.email);
  }
  return [...out];
}

// Fire and forget: a failed notification never fails the work that caused it.
function notifySoon(emailsOrPromise, payload) {
  Promise.resolve(emailsOrPromise)
    .then((emails) => notify(emails, payload))
    .catch((e) => console.warn("[push] notify failed:", e && e.message));
}

function setSender(fn) {
  sender = fn;
}

module.exports = { vapidKeys, notify, notifySoon, teamEmails, setSender };
