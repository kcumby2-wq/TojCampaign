/* Notifications for the TOJ app: turn on, turn off, send a test.
 * On iPhone they work once TOJ is on the Home Screen (iOS 16.4 or later).
 */
(function () {
  "use strict";
  function supported() { return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window; }
  function ios() { return /iphone|ipad|ipod/i.test(navigator.userAgent); }
  function standalone() { return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true; }
  function keyBytes(b64) {
    var pad = "=".repeat((4 - (b64.length % 4)) % 4);
    var raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  async function current() {
    var reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }
  async function status() {
    if (!supported()) return ios() && !standalone() ? "install-first" : "unsupported";
    if (Notification.permission === "denied") return "denied";
    try { return (await current()) ? "on" : "off"; } catch (e) { return "off"; }
  }
  async function enable() {
    var perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error("Notifications weren't allowed. You can allow them in Settings.");
    var k = await window.TOJ.api("/api/push/key");
    var reg = await navigator.serviceWorker.ready;
    var sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(k.publicKey) }));
    await window.TOJ.post("/api/push/subscribe", { subscription: sub.toJSON() });
  }
  async function disable() {
    var sub = await current();
    if (sub) {
      try { await window.TOJ.post("/api/push/unsubscribe", { endpoint: sub.endpoint }); } catch (e) {}
      await sub.unsubscribe();
    }
  }
  async function row(el) {
    if (!el) return;
    var h = window.TOJ.h;
    var s = await status();
    var text = {
      on: "On. You'll hear when a draft or a brief needs you.",
      off: "Off. Turn on to hear when a draft or a brief needs you.",
      denied: "Blocked for this app. Allow notifications for TOJ in your phone's Settings.",
      "install-first": "Add TOJ to your Home Screen first (Share, then Add to Home Screen), then turn them on here.",
      unsupported: "This browser can't show notifications.",
    }[s];
    el.innerHTML =
      '<div class="li" style="cursor:default;flex-wrap:wrap"><div class="grow"><div class="name" style="font-size:15.5px">Notifications</div><div class="sub">' + h(text) + "</div></div>" +
      (s === "on" || s === "off" ? '<input type="checkbox" class="switch" role="switch" id="pushSw" aria-label="Notifications"' + (s === "on" ? " checked" : "") + ">" : "") +
      (s === "on" ? '<button type="button" class="btn small soft" id="pushTest" style="margin-left:auto">Send a test</button>' : "") + "</div>";
    var sw = el.querySelector("#pushSw");
    if (sw) sw.addEventListener("change", async function () {
      sw.disabled = true;
      try { if (sw.checked) await enable(); else await disable(); window.TOJ.toast(sw.checked ? "Notifications on." : "Notifications off."); }
      catch (e) { window.TOJ.toast(e.message); }
      row(el);
    });
    var t = el.querySelector("#pushTest");
    if (t) t.addEventListener("click", async function () {
      try { var r = await window.TOJ.post("/api/push/test"); window.TOJ.toast(r.sent ? "Sent. It should arrive in a moment." : "Nothing sent. Turn notifications off and on again."); } catch (e) { window.TOJ.toast(e.message); }
    });
  }
  window.TOJPush = { supported: supported, status: status, enable: enable, disable: disable, row: row };
})();
