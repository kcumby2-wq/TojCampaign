// A creator's landing page (/c/<slug>), built from their profile.
//
// The look follows Kyron's creator template (creator.config.js + style.css):
// colors and fonts come from the profile's theme as CSS variables. Every value
// is escaped. Nothing about a buyer or an athlete is ever on this page; the
// buy form posts to /api/creators/public/<slug>/checkout and Stripe takes it
// from there.

"use strict";

const { FONTS } = require("./creators");

function h(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function rgba(hex, a) {
  const n = parseInt(String(hex || "#000000").slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function money(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}
function fontOrDefault(name, fallback) {
  return FONTS.includes(name) ? name : fallback;
}
function dateWords(d) {
  if (!d) return "";
  const [y, m, day] = String(d).slice(0, 10).split("-").map(Number);
  if (!y || !m || !day) return "";
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${day}, ${y}`;
}

// opts: { nonce, event, crew: [{name, code}], crewCode, stripeMode: 'test'|'live'|null, preview, paid, checkoutUrl }
function renderPage(c, opts = {}) {
  // Colors go into CSS, so only real hex colors get through.
  const raw = c.theme || {};
  const col = (v, d) => (/^#[0-9a-fA-F]{6}$/.test(String(v || "")) ? v : d);
  const t = { ...raw, primary: col(raw.primary, "#e10f1c"), accent: col(raw.accent, "#ff2433"), bg: col(raw.bg, "#0a0a0a"), bgCard: col(raw.bgCard, "#1a1a1a"), text: col(raw.text, "#f5f5f5"), gold: col(raw.gold, "#ffcc55") };
  const display = fontOrDefault(t.displayFont, "Anton");
  const body = fontOrDefault(t.bodyFont, "DM Sans");
  const fontsHref = `https://fonts.googleapis.com/css2?family=${[display, body, "Space Mono"].filter((v, i, a) => a.indexOf(v) === i).map((f) => encodeURIComponent(f).replace(/%20/g, "+") + (f === body ? ":wght@400;500;600;700" : "")).join("&family=")}&display=swap`;
  const lines = (c.hero_lines && c.hero_lines.length ? c.hero_lines : ["PROFESSIONAL", "SPORTS MEDIA", "COVERAGE"]).slice(0, 3);
  const pk = Array.isArray(c.packages) ? c.packages : [];
  const team = c.team_tier && c.team_tier.show ? c.team_tier : null;
  const ev = opts.event || null;
  const crew = Array.isArray(opts.crew) ? opts.crew : [];
  const nonce = h(opts.nonce || "");
  const checkoutOn = opts.stripeMode === "test" || opts.stripeMode === "live";

  const strip = opts.preview
    ? `<div class="strip">Preview. This page isn't live yet.</div>`
    : opts.stripeMode === "test"
      ? `<div class="strip">Test mode. No real charges: use card 4242 4242 4242 4242, any future date, any CVC.</div>`
      : !checkoutOn
        ? `<div class="strip">Checkout isn't switched on yet.</div>`
        : "";

  const cards = pk
    .map(
      (k) => `<article class="pkg${k.featured ? " featured" : ""}">${k.featured ? '<span class="tag">MOST POPULAR</span>' : ""}<h3>${h(k.name)}</h3><p class="price"><sup>$</sup>${h(money(k.price))}</p><p class="desc">${h(k.desc)}</p><ul>${(k.features || []).map((f) => `<li>${h(f)}</li>`).join("")}</ul><button type="button" class="buy" data-pkg="${h(k.id)}" data-name="${h(k.name)}" data-price="${h(money(k.price))}">Get ${h(k.name)}</button></article>`
    )
    .join("");

  const teamHtml = team
    ? `<section class="team"><div><p class="team-tag">TEAMS</p><h3>${h(team.name)}</h3><p class="desc">${h(team.desc)}</p></div><div class="team-buy"><p class="team-price">$${h(money(team.price))}</p><button type="button" class="buy gold" data-pkg="team" data-name="${h(team.name)}" data-price="${h(money(team.price))}">Book the team</button></div></section>`
    : "";

  const evHtml = ev
    ? `<div class="event"><span>At</span> ${h(ev.name)}${ev.event_date ? ` · ${h(dateWords(ev.event_date))}` : ""}${ev.venue ? ` · ${h(ev.venue)}` : ""}</div>`
    : "";

  const crewHtml = crew.length
    ? `<label>Who did you talk to? <small>(optional)</small><select name="crew"><option value="">Nobody in particular</option>${crew.map((m) => `<option value="${h(m.code)}"${m.code === opts.crewCode ? " selected" : ""}>${h(m.name)}</option>`).join("")}</select></label>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${h(c.brand_name)} · Sports media coverage</title>
<meta name="description" content="${h(c.tagline)}">
<meta property="og:title" content="${h(c.brand_name)}">
<meta property="og:description" content="${h(c.tagline)}">
${opts.preview || opts.stripeMode !== "live" ? '<meta name="robots" content="noindex, nofollow">' : ""}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${h(fontsHref)}" rel="stylesheet">
<style nonce="${nonce}">
:root{--primary:${h(t.primary)};--accent:${h(t.accent)};--bg:${h(t.bg)};--card:${h(t.bgCard)};--text:${h(t.text)};--gold:${h(t.gold || "#ffcc55")};--muted:${rgba(t.text, 0.62)};--border:${rgba(t.primary, 0.28)};--glow:${rgba(t.primary, 0.14)};--display:'${h(display)}',sans-serif;--body:'${h(body)}',sans-serif;--mono:'Space Mono',monospace}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{background:var(--bg);color:var(--text);font-family:var(--body);font-size:16px;line-height:1.5;min-height:100vh}
.strip{background:var(--gold);color:#111;font:600 13px/1.4 var(--body);text-align:center;padding:8px 16px}
.paid{background:var(--card);border:1px solid var(--accent);color:var(--text);border-radius:12px;padding:14px 16px;margin:16px auto 0;max-width:860px;width:calc(100% - 32px);font-size:15px}
nav{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid var(--border);position:sticky;top:0;background:${rgba(t.bg, 0.92)};backdrop-filter:blur(10px);z-index:5}
.brand{font-family:var(--display);font-size:22px;letter-spacing:.5px;color:var(--accent);text-transform:uppercase}
.handle{font:12px var(--mono);letter-spacing:1px;color:var(--muted)}
.hero{text-align:center;padding:56px 16px 40px;position:relative;overflow:hidden}
.hero:before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse 80% 60% at 50% 0%,var(--glow),transparent 70%);pointer-events:none}
.eyebrow{font:11px var(--mono);letter-spacing:4px;text-transform:uppercase;color:var(--accent);margin-bottom:14px}
.badge{display:inline-block;border:1px solid var(--border);border-radius:40px;padding:7px 14px;font:12px var(--mono);letter-spacing:1px;color:var(--muted);margin-bottom:22px}
h1{font-family:var(--display);font-size:clamp(44px,11vw,88px);line-height:.92;letter-spacing:1px;text-transform:uppercase;margin-bottom:18px;font-weight:400}
h1 .accent{color:var(--accent)}
.tagline{color:var(--muted);max-width:480px;margin:0 auto 24px;font-size:16px}
.event{display:inline-block;background:var(--glow);border:1px solid var(--border);border-radius:10px;padding:10px 14px;font-size:14px;margin-bottom:22px}
.event span{font:11px var(--mono);letter-spacing:2px;text-transform:uppercase;color:var(--accent)}
.cta{display:inline-block;background:var(--primary);color:#fff;text-decoration:none;font-weight:700;letter-spacing:1px;padding:14px 26px;border-radius:10px;font-size:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;padding:8px 16px 32px;max-width:900px;margin:0 auto}
.pkg{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:22px;position:relative;display:flex;flex-direction:column}
.pkg.featured{border-color:var(--primary)}
.tag{position:absolute;top:-10px;left:50%;transform:translateX(-50%);background:var(--primary);color:#fff;font:700 10px var(--mono);letter-spacing:2px;padding:3px 12px;border-radius:20px;white-space:nowrap}
.pkg h3,.team h3{font-family:var(--display);font-size:24px;letter-spacing:.5px;text-transform:uppercase;font-weight:400;margin-bottom:4px}
.price{font-size:30px;font-weight:700;color:var(--accent);margin-bottom:6px}
.price sup{font-size:15px;vertical-align:top;position:relative;top:6px}
.desc{color:var(--muted);font-size:14px;margin-bottom:14px}
.pkg ul{list-style:none;margin-bottom:18px;flex:1}
.pkg li{font-size:14px;padding:6px 0;border-bottom:1px solid ${rgba(t.text, 0.07)}}
.pkg li:before{content:'→ ';color:var(--accent)}
.buy{width:100%;min-height:48px;border-radius:10px;border:1px solid var(--border);background:transparent;color:var(--accent);font:700 14px var(--body);letter-spacing:.5px;cursor:pointer}
.pkg.featured .buy{background:var(--primary);color:#fff;border-color:var(--primary)}
.team{max-width:868px;margin:0 auto 40px;width:calc(100% - 32px);background:var(--card);border:1px solid ${rgba(t.gold || "#ffcc55", 0.35)};border-radius:16px;padding:24px;display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:space-between}
.team-tag{font:10px var(--mono);letter-spacing:3px;color:var(--gold);margin-bottom:6px}
.team-price{font-size:34px;font-weight:700;color:var(--gold)}
.buy.gold{background:var(--gold);color:#111;border-color:var(--gold);width:auto;padding:0 24px}
footer{border-top:1px solid var(--border);padding:22px 16px 40px;text-align:center;color:var(--muted);font:11px var(--mono);letter-spacing:1.5px}
footer a{color:var(--muted)}
dialog{border:1px solid var(--border);border-radius:16px;background:var(--card);color:var(--text);width:min(460px,calc(100% - 24px));padding:22px;margin:auto}
dialog::backdrop{background:rgba(0,0,0,.6)}
dialog h2{font-family:var(--display);font-weight:400;text-transform:uppercase;font-size:26px;letter-spacing:.5px}
dialog form{display:flex;flex-direction:column;gap:14px;margin-top:14px}
dialog label{display:flex;flex-direction:column;gap:6px;font-size:14px;font-weight:600}
dialog small{font-weight:400;color:var(--muted)}
dialog input[type=text],dialog select{min-height:46px;border-radius:10px;border:1px solid var(--border);background:var(--bg);color:var(--text);padding:0 12px;font:16px var(--body)}
dialog .check{flex-direction:row;align-items:flex-start;gap:10px;font-weight:500}
dialog .check input{width:22px;height:22px;margin-top:2px;flex:none;accent-color:var(--primary)}
dialog .row{display:flex;gap:10px}
dialog .row button{flex:1;min-height:48px;border-radius:10px;font:700 15px var(--body);cursor:pointer}
.go{background:var(--primary);color:#fff;border:1px solid var(--primary)}
.cancel{background:transparent;color:var(--text);border:1px solid var(--border)}
.msg{font-size:14px;color:var(--gold);min-height:1em}
.fine{font-size:12px;color:var(--muted);font-weight:400}
@media (min-width:700px){nav{padding:14px 32px}.grid{padding:8px 32px 40px}}
</style>
</head>
<body>
${strip}
${opts.paid ? `<div class="paid" role="status"><b>Payment received.</b> You'll get a receipt by email, and ${h(c.brand_name)} will be in touch about delivery.</div>` : ""}
<nav><span class="brand">${h(c.brand_name)}</span>${c.handle ? `<span class="handle">${h(c.handle)}</span>` : ""}</nav>
<header class="hero">
<p class="eyebrow">${h(c.brand_name)}</p>
${c.location || c.handle ? `<p class="badge">${h([c.location, c.handle].filter(Boolean).join("  |  "))}</p>` : ""}
<h1>${h(lines[0] || "")}<br><span class="accent">${h(lines[1] || "")}</span><br>${h(lines[2] || "")}</h1>
<p class="tagline">${h(c.tagline)}</p>
${evHtml}
<div><a class="cta" href="#packages">See packages</a></div>
</header>
<main id="packages">
<section class="grid" aria-label="Packages">${cards}</section>
${teamHtml}
</main>
<footer>${h(c.footer_note || "Creator-owned coverage")} · Payments by Stripe · <a href="https://tojcampaign.com/privacy.html">Privacy</a></footer>
<dialog id="buy" aria-labelledby="buyTitle">
<h2 id="buyTitle">Package</h2>
<p class="fine" id="buyPrice"></p>
<form id="buyForm" novalidate>
<label>Athlete's team and jersey number<input type="text" name="team_jersey" maxlength="80" required autocomplete="off" placeholder="Team name #12"></label>
<label>Athlete's Instagram <small>(optional)</small><input type="text" name="instagram" maxlength="31" autocomplete="off" placeholder="@handle"></label>
${crewHtml}
<label class="check"><input type="checkbox" name="consent_delivery" required><span>I'm the athlete's parent or guardian, or the athlete is 18 or older.</span></label>
<label class="check"><input type="checkbox" name="consent_public"><span>${h(c.brand_name)} may post my athlete's photos and video publicly. <small>(optional; without it, they're delivered only to you)</small></span></label>
<p class="msg" id="buyMsg" role="status"></p>
<div class="row"><button type="button" class="cancel" id="buyCancel">Cancel</button><button type="submit" class="go" id="buyGo">Continue to payment</button></div>
</form>
</dialog>
<script nonce="${nonce}">
(function(){
  var dlg=document.getElementById('buy'),form=document.getElementById('buyForm'),msg=document.getElementById('buyMsg'),go=document.getElementById('buyGo'),pkg=null;
  var ev=${JSON.stringify(ev ? ev.code : null)},checkoutOn=${checkoutOn ? "true" : "false"},preview=${opts.preview ? "true" : "false"},url=${JSON.stringify(opts.checkoutUrl || "")};
  document.querySelectorAll('.buy').forEach(function(b){b.addEventListener('click',function(){
    pkg=b.getAttribute('data-pkg');document.getElementById('buyTitle').textContent=b.getAttribute('data-name');document.getElementById('buyPrice').textContent='$'+b.getAttribute('data-price');msg.textContent='';go.disabled=false;
    if(dlg.showModal)dlg.showModal();else dlg.setAttribute('open','');
  });});
  document.getElementById('buyCancel').addEventListener('click',function(){dlg.close?dlg.close():dlg.removeAttribute('open');});
  form.addEventListener('submit',function(e){
    e.preventDefault();
    var f=new FormData(form);
    if(!String(f.get('team_jersey')||'').trim()){msg.textContent='Add the athlete\\'s team and jersey number so we can find them.';return;}
    if(!f.get('consent_delivery')){msg.textContent='Please confirm you\\'re the parent or guardian, or the athlete is 18 or older.';return;}
    if(preview){msg.textContent='This is a preview. Checkout works once the page is live.';return;}
    if(!checkoutOn){msg.textContent='Checkout isn\\'t switched on yet.';return;}
    go.disabled=true;msg.textContent='One moment…';
    fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({package_id:pkg,event_code:ev,crew_code:f.get('crew')||null,team_jersey:f.get('team_jersey'),instagram:f.get('instagram'),consent_delivery:true,consent_public:!!f.get('consent_public')})})
      .then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d};});})
      .then(function(x){if(x.ok&&x.d.url){location.href=x.d.url;}else{go.disabled=false;msg.textContent=(x.d&&x.d.message)||'Checkout didn\\'t start. Try again in a minute.';}})
      .catch(function(){go.disabled=false;msg.textContent='Checkout didn\\'t start. Check your connection.';});
  });
})();
</script>
</body>
</html>`;
}

// A printable card: the QR, the brand, the event, and (for a crew member's
// card) their name so their sales are credited.
function renderCard(c, { event, qrSvg, pageUrl, crewName, nonce }) {
  const t = { primary: /^#[0-9a-fA-F]{6}$/.test(String((c.theme || {}).primary || "")) ? c.theme.primary : "#111111" };
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${h(c.brand_name)} · QR card</title>
<style nonce="${h(nonce || "")}">
*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,Helvetica,sans-serif;background:#eee;padding:24px;color:#111}
.card{width:min(4in,100%);min-height:6in;margin:0 auto;background:#fff;border-radius:12px;padding:28px 24px;text-align:center;border-top:10px solid ${h(t.primary || "#111")}}
.brand{font-weight:800;font-size:22px;letter-spacing:.5px;text-transform:uppercase;color:${h(t.primary || "#111")}}
.ev{font-size:14px;margin-top:6px;color:#333}.qr{width:2.6in;height:2.6in;margin:18px auto}.qr svg{width:100%;height:100%}
.ask{font-weight:700;font-size:18px}.url{font-size:11px;color:#555;margin-top:8px;word-break:break-all}.crew{margin-top:12px;font-size:13px;color:#333}
.print{display:block;margin:16px auto 0;padding:10px 18px;font-size:15px}@media print{body{background:#fff;padding:0}.print{display:none}.card{border-radius:0}}
</style></head><body>
<div class="card"><p class="brand">${h(c.brand_name)}</p><p class="ev">${h(event.name)}${event.event_date ? " · " + h(dateWords(event.event_date)) : ""}</p>
<div class="qr" role="img" aria-label="QR code for ${h(c.brand_name)}">${qrSvg}</div>
<p class="ask">Scan for your athlete's photos and video</p>${crewName ? `<p class="crew">Ask for ${h(crewName)}</p>` : ""}<p class="url">${h(pageUrl)}</p></div>
<button type="button" class="print" id="p">Print</button>
<script nonce="${h(nonce || "")}">document.getElementById('p').addEventListener('click',function(){window.print();});</script>
</body></html>`;
}

module.exports = { renderPage, renderCard, dateWords };
