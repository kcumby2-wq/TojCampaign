// The TOJ iPhone app's native layer: camera, notifications from Apple, and
// the Share inbox. Bundled into public/app/native.js (`npm run bundle` here)
// and loaded by /app/ only inside the iPhone app, whose user agent carries
// "TOJApp/1" (capacitor.config.json). In a browser this file never loads.
//
// window.TOJNative = {
//   takePhoto()          → { media_type, data } (base64 JPEG, max 1280 px), or null if cancelled
//   push.status()        → "on" | "off" | "denied"
//   push.enable(post)    → registers with Apple, sends the token to /api/push/subscribe
//   push.disable(post)   → forgets this phone
//   push.refresh(post)   → re-sends the token if notifications are on (tokens can change)
//   takeShared()         → things shared to TOJ from other apps, removed from the phone as they're taken
//   sharedCount()        → how many are waiting
// }
// Events on window: "toj:resume" when the app comes back to the front.

import { Capacitor, registerPlugin } from "@capacitor/core";
import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
import { PushNotifications } from "@capacitor/push-notifications";
import { App } from "@capacitor/app";

const SharedInbox = registerPlugin("SharedInbox");
const TOKEN_KEY = "toj.apnsToken";

function store(k, v) {
  try {
    if (v == null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch (e) {}
}
function load(k) {
  try {
    return localStorage.getItem(k);
  } catch (e) {
    return null;
  }
}

// Only links into the app itself, as a hash route.
function openUrl(url) {
  if (typeof url !== "string" || url.indexOf("/app/") !== 0) return;
  const hash = url.slice(5);
  location.hash = /^#[a-z]/.test(hash) ? hash : "#today";
}

let waiters = [];
let listening = null;
function listen() {
  if (listening) return listening;
  listening = Promise.all([
    PushNotifications.addListener("registration", (t) => {
      store(TOKEN_KEY, t.value);
      waiters.forEach((w) => w.resolve(t.value));
      waiters = [];
    }),
    PushNotifications.addListener("registrationError", (e) => {
      waiters.forEach((w) => w.reject(new Error("Apple didn't register this phone for notifications" + (e && e.error ? " (" + e.error + ")" : "") + ".")));
      waiters = [];
    }),
    PushNotifications.addListener("pushNotificationActionPerformed", (a) => {
      openUrl(a && a.notification && a.notification.data && a.notification.data.url);
    }),
  ]);
  return listening;
}

function registerForToken() {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Apple didn't answer. Try again in a minute.")), 20000);
    waiters.push({
      resolve: (v) => { clearTimeout(t); resolve(v); },
      reject: (e) => { clearTimeout(t); reject(e); },
    });
    PushNotifications.register().catch((e) => { clearTimeout(t); reject(e); });
  });
}

const push = {
  async status() {
    const p = await PushNotifications.checkPermissions();
    if (p.receive === "denied") return "denied";
    return p.receive === "granted" && load(TOKEN_KEY) ? "on" : "off";
  },
  async enable(post) {
    await listen();
    let p = await PushNotifications.checkPermissions();
    if (p.receive !== "granted") p = await PushNotifications.requestPermissions();
    if (p.receive !== "granted") throw new Error("Notifications weren't allowed. You can turn them on in Settings › TOJ › Notifications.");
    const token = await registerForToken();
    return post("/api/push/subscribe", { apns: { token } });
  },
  async disable(post) {
    const token = load(TOKEN_KEY);
    store(TOKEN_KEY, null);
    if (token) {
      try { await post("/api/push/unsubscribe", { endpoint: "apns:" + token.toLowerCase() }); } catch (e) {}
    }
    try { await PushNotifications.unregister(); } catch (e) {}
  },
  async refresh(post) {
    await listen();
    if (!load(TOKEN_KEY)) return;
    const p = await PushNotifications.checkPermissions();
    if (p.receive !== "granted") return;
    try {
      const token = await registerForToken();
      await post("/api/push/subscribe", { apns: { token } });
    } catch (e) {}
  },
};

async function takePhoto() {
  try {
    const p = await Camera.getPhoto({
      source: CameraSource.Camera,
      resultType: CameraResultType.Base64,
      quality: 82,
      width: 1280,
      height: 1280,
      correctOrientation: true,
      saveToGallery: false,
    });
    return { media_type: p.format === "png" ? "image/png" : "image/jpeg", data: p.base64String };
  } catch (e) {
    if (/cancel/i.test(String((e && e.message) || e))) return null;
    throw new Error("The camera didn't open. Allow it in Settings › TOJ › Camera.");
  }
}

async function takeShared() {
  const r = await SharedInbox.take();
  return (r && r.shares) || [];
}
async function sharedCount() {
  const r = await SharedInbox.count();
  return (r && r.count) || 0;
}

if (Capacitor.isNativePlatform()) {
  window.TOJNative = { platform: Capacitor.getPlatform(), takePhoto, push, takeShared, sharedCount, openUrl };
  listen();
  App.addListener("appStateChange", (s) => {
    if (s && s.isActive) window.dispatchEvent(new Event("toj:resume"));
  });
}
