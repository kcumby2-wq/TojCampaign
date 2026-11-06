"use strict";
// The family-facing pages of the Subject Medias marketplace, as HTML strings
// (routes/sm-market-public.js serves them on subjectmedias.com/m/...). The
// site's own look: the dark ground, chalk text, the green mark, Archivo.
//
// Nothing here names an athlete: a team and a jersey number at most. Every
// value is escaped; the only script is a small nonce'd one that keeps the
// order total up to date, and the pages work without it.

const M = require("./sm-market");

const esc = (v) =>
  String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const helpEmail = M.helpEmail;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dateRange(starts, ends) {
  const p = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
    return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null;
  };
  const a = p(starts);
  const b = p(ends) || a;
  if (!a) return "";
  if (a.y === b.y && a.m === b.m && a.d === b.d) return `${MONTHS[a.m]} ${a.d}, ${a.y}`;
  if (a.y === b.y && a.m === b.m) return `${MONTHS[a.m]} ${a.d}–${b.d}, ${a.y}`;
  if (a.y === b.y) return `${MONTHS[a.m]} ${a.d} – ${MONTHS[b.m]} ${b.d}, ${a.y}`;
  return `${MONTHS[a.m]} ${a.d}, ${a.y} – ${MONTHS[b.m]} ${b.d}, ${b.y}`;
}
function place(ev) {
  const town = [ev.city, ev.state].filter(Boolean).join(", ");
  return [ev.venue, town].filter(Boolean).join(", ");
}
const dollars = (cents) => {
  const n = Number(cents || 0) / 100;
  return "$" + (Number.isInteger(n) ? String(n) : n.toFixed(2));
};
function length(ms) {
  if (!ms && ms !== 0) return "";
  const s = Math.max(1, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const CSS = `
:root{color-scheme:dark;--ground:#050605;--panel:#0d110e;--panel-2:#121813;--line:#1f2621;--line-2:#2c352e;--chalk:#f1f4ee;--chalk-2:rgba(241,244,238,.82);--smoke:#9da69d;--green:#62d344;--green-hi:#8eea72;--err:#ff8a7a;--sans:"Archivo","Arial Narrow",Arial,sans-serif;--mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none!important}
html{background:var(--ground);-webkit-text-size-adjust:100%}
body{margin:0;background:var(--ground);color:var(--chalk);font-family:var(--sans);font-size:1.0625rem;line-height:1.55;font-weight:420;-webkit-font-smoothing:antialiased}
img,video{display:block;max-width:100%}
a{color:inherit}
p{text-wrap:pretty}
button,input,select{font:inherit;color:inherit}
:focus-visible{outline:3px solid var(--green);outline-offset:3px;border-radius:6px}
.wrap{width:100%;max-width:1080px;margin-inline:auto;padding-left:max(18px,env(safe-area-inset-left,0px));padding-right:max(18px,env(safe-area-inset-right,0px))}
.top{border-bottom:1px solid var(--line)}
.top .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-block:14px}
.mark{display:inline-grid;text-decoration:none;font-weight:900;font-stretch:104%;text-transform:uppercase;line-height:.86;font-size:1.05rem;letter-spacing:.004em}
.mark b{color:var(--green);font-weight:inherit}
.top small{font-family:var(--mono);font-size:.72rem;color:var(--smoke);text-align:right}
main.wrap{padding-block:clamp(28px,6vw,56px) 72px}
.ev-name{margin:0;font-weight:900;font-stretch:112%;font-size:clamp(2.4rem,9vw,4.6rem);line-height:.9;letter-spacing:-.012em;text-transform:uppercase;text-wrap:balance}
.ev-meta{margin:14px 0 0;font-family:var(--mono);font-size:.82rem;color:var(--smoke);max-width:60ch}
.lede{margin:18px 0 0;font-size:clamp(1.05rem,2.6vw,1.2rem);color:var(--chalk-2);max-width:56ch}
.card{margin-top:28px;padding:clamp(18px,4vw,30px);border:1px solid var(--line);border-radius:22px;background:var(--panel)}
.card h2{margin:0 0 6px;font-weight:900;font-stretch:108%;font-size:clamp(1.4rem,4.4vw,1.9rem);line-height:1;text-transform:uppercase}
.card > p{margin:8px 0 0;color:var(--chalk-2);max-width:60ch}
.fgrid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:14px;margin-top:18px}
.f{display:grid;gap:7px;align-content:start;min-width:0;grid-column:span 6}
.f.half{grid-column:span 3}
.f > span,.f legend{font-size:.86rem;font-weight:700;color:var(--chalk-2)}
.f small{color:var(--smoke);font-size:.8rem}
fieldset.f{border:0;margin:0;padding:0}
.input,.select{width:100%;min-height:50px;padding:12px 14px;border:1.5px solid var(--line-2);border-radius:14px;background:var(--ground);color:var(--chalk);font-size:1rem}
.select{appearance:none;-webkit-appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--smoke) 50%),linear-gradient(135deg,var(--smoke) 50%,transparent 50%);background-position:calc(100% - 20px) 50%,calc(100% - 14px) 50%;background-size:6px 6px;background-repeat:no-repeat;padding-right:38px}
.input:focus,.select:focus{border-color:var(--green);outline:none}
.f.bad .input,.f.bad .select{border-color:var(--err)}
.f.bad > span,.f.bad legend{color:var(--err)}
.choices{display:grid;gap:8px}
.choice{position:relative;display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 12px;padding:14px;border:1.5px solid var(--line-2);border-radius:14px;cursor:pointer}
.choice input{grid-row:span 2;width:20px;height:20px;margin:2px 0 0;accent-color:var(--green)}
.choice b{font-weight:800}
.choice small{color:var(--smoke);font-size:.88rem;line-height:1.45}
.choice:has(input:checked){border-color:var(--green);background:rgba(98,211,68,.08)}
.seg{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.seg label{position:relative}
.seg input{position:absolute;opacity:0;inset:0;cursor:pointer}
.seg span{display:flex;align-items:center;justify-content:center;min-height:48px;padding:8px 10px;border:1.5px solid var(--line-2);border-radius:14px;font-weight:750;text-align:center}
.seg input:checked + span{border-color:var(--green);background:rgba(98,211,68,.12)}
.seg input:focus-visible + span{outline:3px solid var(--green);outline-offset:2px}
.check{display:flex;gap:12px;align-items:flex-start;grid-column:span 6;padding:12px 14px;border:1.5px solid var(--line-2);border-radius:14px;cursor:pointer;font-size:.95rem;color:var(--chalk-2)}
.check input{width:20px;height:20px;margin:2px 0 0;flex:none;accent-color:var(--green)}
.check.bad{border-color:var(--err)}
.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
.pill{display:inline-flex;align-items:center;justify-content:center;gap:.55em;min-height:52px;padding:.8em 1.5em;border:2px solid transparent;border-radius:999px;font-weight:750;font-stretch:104%;font-size:1rem;line-height:1;text-decoration:none;cursor:pointer}
.pill-green{background:var(--green);color:#000}
.pill-green:hover{background:var(--green-hi)}
.pill-line{border-color:rgba(241,244,238,.5);color:var(--chalk);background:transparent}
.pill:disabled{opacity:.5;cursor:not-allowed}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:12px 16px;margin-top:20px}
.msg{margin:16px 0 0;padding:12px 14px;border-radius:12px;background:rgba(255,138,122,.1);color:var(--err);font-weight:600}
.note{margin:14px 0 0;font-size:.92rem;color:var(--smoke)}
.link-box{margin-top:14px;padding:14px;border:1.5px dashed var(--line-2);border-radius:14px;font-family:var(--mono);font-size:.82rem;overflow-wrap:anywhere;user-select:all}
.res-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:6px 16px;margin:36px 0 0}
.res-head h2{margin:0;font-weight:900;font-stretch:108%;font-size:clamp(1.6rem,5.4vw,2.4rem);line-height:1;text-transform:uppercase}
.res-head p{margin:0;font-family:var(--mono);font-size:.8rem;color:var(--smoke)}
.items{list-style:none;margin:18px 0 0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr));gap:16px}
.item{min-width:0;border:1px solid var(--line);border-radius:18px;background:var(--panel);overflow:hidden}
.frame{background:#000;aspect-ratio:16/9;display:grid;place-items:center}
.frame video,.frame img{width:100%;height:100%;object-fit:contain}
.add{display:flex;align-items:center;gap:12px;padding:12px 14px;cursor:pointer}
.add input{width:22px;height:22px;flex:none;accent-color:var(--green)}
.add span{flex:1;min-width:0;color:var(--chalk-2)}
.add b{font-weight:850;font-size:1.1rem}
.item:has(input:checked){border-color:var(--green)}
.bar{position:sticky;bottom:0;z-index:5;margin-top:22px;padding:14px max(16px,env(safe-area-inset-right,0px)) calc(14px + env(safe-area-inset-bottom,0px)) max(16px,env(safe-area-inset-left,0px));border:1px solid var(--line-2);border-radius:18px 18px 0 0;background:rgba(13,17,14,.96);display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 16px}
.bar p{margin:0;font-weight:700}
.bar small{display:block;font-weight:500;color:var(--smoke);font-size:.82rem}
.empty{margin-top:22px;padding:22px;border:1.5px dashed var(--line-2);border-radius:18px;color:var(--chalk-2)}
.dl{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 14px;padding:12px 14px}
.dl span{color:var(--chalk-2)}
.gone{padding:12px 14px;color:var(--smoke);font-size:.92rem}
.foot{padding-block:28px 40px;border-top:1px solid var(--line);font-size:.9rem;color:var(--smoke)}
.foot p{margin:0;max-width:62ch}
.foot a{color:var(--chalk)}
@media (max-width:560px){.f.half{grid-column:span 6}}
`;

const FONTS = "https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&family=JetBrains+Mono:wght@500&display=swap";

function shell({ nonce, title, body, script = "", refresh = 0 }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
${refresh ? `<meta http-equiv="refresh" content="${Number(refresh)}">\n` : ""}<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<style nonce="${esc(nonce)}">${CSS}</style>
</head>
<body>
<header class="top"><div class="wrap"><a class="mark" href="https://www.subjectmedias.com/"><span>Subject</span><b>Medias</b></a><small>Clips and photos from our events</small></div></header>
<main class="wrap">
${body}
</main>
<footer class="foot"><div class="wrap"><p>Questions, a change of mind, or a clip you want taken down: <a href="mailto:${esc(helpEmail())}">${esc(helpEmail())}</a>. We never post names, and we check every clip before it goes up.</p></div></footer>
${script ? `<script nonce="${esc(nonce)}">${script}</script>` : ""}
</body>
</html>`;
}

function evHead(ev, sub = "") {
  const meta = [dateRange(ev.starts_on, ev.ends_on), place(ev)].filter(Boolean).join(" at ");
  return `<h1 class="ev-name">${esc(ev.name)}</h1>
<p class="ev-meta">${esc(meta)}</p>${sub ? `\n<p class="lede">${sub}</p>` : ""}`;
}

const teamOptions = (teams, chosen) =>
  `<option value="">Pick a team</option>` + teams.map((t) => `<option value="${esc(t.id)}"${t.id === chosen ? " selected" : ""}>${esc(t.name)}</option>`).join("");

// ── The event page ───────────────────────────────────────────────────────
// Without the event's access code: how to get in. The code is on the clips
// QR and the check-in handout, never on the public consent poster.
function eventGatePage({ nonce, event, error = "" }) {
  let body = evHead(event, "Clips and photos from this event are for the families who were there.");
  body += `<form class="card" method="get" action="/m/${esc(event.code)}">
<h2>Enter the access code</h2>
<p>It's on the card from check-in, and in the clips link your team or coach shared. Made your choice as a parent or guardian? Your family link, in its email, opens your athlete's clips without a code.</p>
<div class="fgrid">
<label class="f half${error ? " bad" : ""}"><span>Access code</span><input class="input" name="k" placeholder="ABCD-EFGH" autocapitalize="characters" autocomplete="off" spellcheck="false" maxlength="12" required></label>
</div>
${error ? `<p class="msg" role="alert">${esc(error)}</p>` : ""}
<div class="row"><button class="pill pill-green" type="submit">Open the clips</button><a class="note" href="/m/${esc(event.code)}/consent">Parent or guardian? Choose how your athlete's footage is used.</a></div>
</form>`;
  return shell({ nonce, title: `${event.name} | Subject Medias`, body });
}

// With the code: find an athlete by team and number, then the clips and
// photos everyone in them has said may be sold. key: the access code, carried
// in the forms so they keep working.
function eventPage({ nonce, event, teams, key = "", team = null, jersey = "", items = null, error = "" }) {
  const sub = "Find your athlete by team and jersey number. You see watermarked previews here; what you buy comes in full quality, with no watermark.";
  let body = evHead(event, esc(sub));
  if (event.status === "draft") {
    body += `<div class="card"><h2>Not open yet</h2><p>Clips and photos from this event show up here once our crew has checked them, usually within a day or two after the event.</p><div class="row"><a class="pill pill-line" href="/m/${esc(event.code)}/consent">Parent or guardian? Make your choice</a></div></div>`;
    return shell({ nonce, title: `${event.name} | Subject Medias`, body });
  }
  body += `<form class="card" method="get" action="/m/${esc(event.code)}">
<input type="hidden" name="k" value="${esc(key)}">
<h2>Find your athlete</h2>
<div class="fgrid">
<label class="f half"><span>Team</span><select class="select" name="team" required>${teamOptions(teams, team && team.id)}</select></label>
<label class="f half"><span>Jersey number</span><input class="input" name="jersey" value="${esc(jersey)}" inputmode="numeric" pattern="#?[0-9]{1,3}" maxlength="4" autocomplete="off" required></label>
</div>
${error ? `<p class="msg" role="alert">${esc(error)}</p>` : ""}
<div class="row"><button class="pill pill-green" type="submit">Show clips and photos</button><a class="note" href="/m/${esc(event.code)}/consent">Parent or guardian? Choose how your athlete's footage is used.</a></div>
</form>`;
  if (items && team) {
    body += results({ action: `/m/${esc(event.code)}/checkout`, hidden: { k: key, team: team.id, jersey }, label: `${team.name} #${jersey}`, items, event });
  }
  return shell({ nonce, title: `${event.name} | Subject Medias`, body, script: items && items.length ? TOTAL_SCRIPT : "" });
}

function results({ action, hidden, label, items, event }) {
  const clips = items.filter((i) => i.kind === "clip").length;
  const photos = items.length - clips;
  const count = [clips ? `${clips} clip${clips === 1 ? "" : "s"}` : "", photos ? `${photos} photo${photos === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ");
  let out = `<div class="res-head"><h2>${esc(label)}</h2><p>${esc(count || "Nothing yet")}</p></div>`;
  if (!items.length) {
    return out + `<p class="empty">Nothing for ${esc(label)} yet. Our crew checks every clip and photo before it goes up, which can take a day or two after the event. Check the team and number, or come back soon.</p>`;
  }
  const hiddenInputs = Object.entries(hidden || {}).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
  const cards = items
    .map((it, i) => {
      const price = it.kind === "photo" ? event.photo_cents : event.clip_cents;
      const name = it.kind === "clip" ? `Clip ${i + 1}${it.duration_ms ? `, ${length(it.duration_ms)}` : ""}` : `Photo ${i + 1}`;
      const media =
        it.kind === "clip"
          ? `<video controls playsinline preload="none"${it.poster_url ? ` poster="${esc(it.poster_url)}"` : ""} src="${esc(it.preview_url || "")}" aria-label="${esc(name)}, watermarked preview"></video>`
          : `<img src="${esc(it.preview_url || it.poster_url || "")}" alt="${esc(name)}, watermarked preview" loading="lazy">`;
      return `<li class="item"><div class="frame">${media}</div><label class="add"><input type="checkbox" name="item" value="${esc(it.id)}" data-cents="${Number(price)}" data-kind="${esc(it.kind)}"><span>${esc(name)}</span><b>${esc(dollars(price))}</b></label></li>`;
    })
    .join("");
  return (
    out +
    `<form method="post" action="${action}" data-total>${hiddenInputs}
<ul class="items">${cards}</ul>
<div class="bar"><p data-sum>Tick the ones you want.<small>Full quality, no watermark. Pay on the next page.</small></p><button class="pill pill-green" type="submit">Check out</button></div>
</form>`
  );
}

// Keeps the bar's total right as boxes are ticked. The page works without it.
const TOTAL_SCRIPT = `(function(){var f=document.querySelector("[data-total]");if(!f)return;var s=f.querySelector("[data-sum]"),b=f.querySelector("button[type=submit]");function u(){var c=0,p=0,t=0;f.querySelectorAll("input[name=item]:checked").forEach(function(i){t+=+i.getAttribute("data-cents");i.getAttribute("data-kind")==="clip"?c++:p++});var w=[];if(c)w.push(c+(c===1?" clip":" clips"));if(p)w.push(p+(p===1?" photo":" photos"));s.textContent=w.length?w.join(", ")+": $"+(t%100?(t/100).toFixed(2):t/100):"Tick the ones you want.";b.disabled=!w.length}f.addEventListener("change",u);u()})();`;

// ── Consent ──────────────────────────────────────────────────────────────
const CHOICES = [
  ["family", "Family only", "Only your family sees and buys their clips and photos, on your own family link."],
  ["sell", "OK to sell", "Families at this event can find and buy them by team and jersey number, on the event's clips page. Not for athletes 12 or younger."],
  ["public", "OK to show publicly", "Also shown where anyone can see them, like our online store and our social pages. Not for athletes 12 or younger."],
  ["out", "Keep them out", "Nothing of your athlete is shown or sold. Anyone can ask for this, and it counts the moment it's sent. For a safety or custody concern, choose this and tell our crew."],
];
const AGES = [
  ["u13", "12 or younger"],
  ["13_15", "13 to 15"],
  ["16_17", "16 or 17"],
  ["18_plus", "18 or older"],
];

function consentPage({ nonce, event, teams, values = {}, errors = [], formError = "" }) {
  const bad = (f) => (errors.includes(f) ? " bad" : "");
  const v = (k) => esc(values[k] == null ? "" : values[k]);
  let body = evHead(event, "You decide how your athlete's clips and photos are used. One form per athlete; each parent or guardian can answer, and the most careful answer is the one we follow.");
  if (!teams.length) {
    body += `<div class="card"><h2>Teams aren't set up yet</h2><p>Our crew adds this event's teams before it starts. Try again soon, or email <a href="mailto:${esc(helpEmail())}">${esc(helpEmail())}</a> and we'll record your choice.</p></div>`;
    return shell({ nonce, title: `Your choice | ${event.name}`, body });
  }
  const choice = CHOICES.map(
    ([val, title, text]) =>
      `<label class="choice"><input type="radio" name="level" value="${val}"${values.level === val ? " checked" : ""} required><b>${esc(title)}</b><small>${esc(text)}</small></label>`
  ).join("");
  body += `<form class="card" method="post" action="/m/${esc(event.code)}/consent" novalidate>
<h2>Your choice</h2>
<div class="fgrid">
<label class="f half${bad("team_id")}"><span>Team</span><select class="select" name="team_id" required>${teamOptions(teams, values.team_id)}</select></label>
<label class="f half${bad("jersey")}"><span>Jersey number</span><input class="input" name="jersey" value="${v("jersey")}" inputmode="numeric" pattern="#?[0-9]{1,3}" maxlength="4" autocomplete="off" required></label>
<fieldset class="f${bad("level")}"><legend>How may we use their clips and photos?</legend><div class="choices">${choice}</div></fieldset>
<fieldset class="f${bad("age")}"><legend>How old is the athlete?</legend><div class="seg">${AGES.map(
    ([val, words]) => `<label><input type="radio" name="age" value="${val}"${values.age === val ? " checked" : ""}><span>${esc(words)}</span></label>`
  ).join("")}</div><small>12 or younger: family only, or keep out. We never sell their clips to other families or show them publicly. Not needed to keep an athlete out.</small></fieldset>
<label class="f${bad("email")}"><span>Your email</span><input class="input" type="email" name="email" value="${v("email")}" autocomplete="email" required><small>We email you a link to confirm. Your choice counts once you do (a keep-out counts straight away).</small></label>
<label class="check${errors.includes("guardian") ? " bad" : ""}"><input type="checkbox" name="guardian" value="yes"${values.guardian ? " checked" : ""}><span>I'm this athlete's parent or legal guardian and I'm 18 or older, or I'm the athlete and a legal adult where I live. (Not needed to keep an athlete out.)</span></label>
</div>
<div class="hp" aria-hidden="true"><label>Leave this empty <input name="sm_trap" tabindex="-1" autocomplete="off"></label></div>
${formError ? `<p class="msg" role="alert">${esc(formError)}</p>` : errors.length ? `<p class="msg" role="alert">Check the fields marked in red.</p>` : ""}
<div class="row"><button class="pill pill-green" type="submit">Send my choice</button></div>
</form>`;
  return shell({ nonce, title: `Your choice | ${event.name}`, body });
}

function consentSentPage({ nonce, event, kept, now = false, mailed }) {
  let body = evHead(event);
  const ask = `<a href="mailto:${esc(helpEmail())}">${esc(helpEmail())}</a>`;
  if (kept) {
    body += `<div class="card"><h2>Kept out</h2><p>Done: nothing of your athlete is shown or sold from this event. ${mailed ? "We've emailed you a note of it." : ""}</p><p>If you change your mind, email ${ask}.</p></div>`;
  } else if (now) {
    body += `<div class="card"><h2>Changed</h2><p>A more careful choice counts straight away, so it's in effect now. ${mailed ? "We've emailed you a note of it." : ""}</p><p>To change it back, send the form again: a less careful choice waits for you to confirm it from your email.</p></div>`;
  } else if (mailed) {
    body += `<div class="card"><h2>Check your email</h2><p>We've sent you a link to confirm your choice. It counts once you confirm, and then you get your family link. Until then, any earlier choice of yours stands.</p><p class="note">Nothing there? Check spam, or send the form again.</p></div>`;
  } else {
    body += `<div class="card"><h2>We couldn't email you just now</h2><p>Your choice is saved, but it needs confirming from your email before it counts. Show this screen to our crew and they'll record it for you, or email ${ask}.</p></div>`;
  }
  return shell({ nonce, title: `Your choice | ${event.name}`, body });
}

function confirmPage({ nonce, event, team, jersey, level, ageBand = "", token = "", done = false, familyLink = null, mailed = false }) {
  let body = evHead(event);
  const age = M.AGE_WORDS[ageBand] ? `, ${M.AGE_WORDS[ageBand]}` : "";
  if (!done) {
    body += `<form class="card" method="post" action="/m/confirm/${esc(token)}">
<h2>Confirm your choice</h2>
<p>${esc(team)} #${esc(jersey)}: <b>${esc(M.LEVEL_WORDS[level] || level)}</b>${esc(age)}.</p>
<div class="row"><button class="pill pill-green" type="submit">Confirm</button></div>
<p class="note">Didn't ask for this? Close this page and nothing changes.</p>
</form>`;
  } else {
    body += `<div class="card"><h2>Confirmed</h2><p>${esc(team)} #${esc(jersey)}: <b>${esc(M.LEVEL_WORDS[level] || level)}</b>${esc(age)}.</p>`;
    if (familyLink) {
      body += `<p>This is your family link. It shows your athlete's clips and photos once our crew has checked them, and it's where you buy. ${mailed ? "We've emailed it to you too." : "Save it: it's how you get back here."} Any family link we sent you before has stopped working.</p><div class="link-box">${esc(familyLink)}</div><div class="row"><a class="pill pill-green" href="${esc(familyLink)}">Open my family link</a></div>`;
    }
    body += `</div>`;
  }
  return shell({ nonce, title: `Confirm | ${event.name}`, body });
}

// ── The family page ──────────────────────────────────────────────────────
function familyPage({ nonce, event, team, jersey, level, items, token, eventLink = "" }) {
  let body = evHead(event, `Your family link for ${esc(team)} #${esc(jersey)}. Keep it to your family: anyone with it sees what it shows.`);
  if (level === "out" || level === "none") {
    const why = level === "out" ? "Your athlete is kept out, so nothing is shown or sold." : "There's no confirmed choice for your athlete right now, so nothing is shown.";
    body += `<div class="card"><h2>Nothing to show</h2><p>${why} To change that, email <a href="mailto:${esc(helpEmail())}">${esc(helpEmail())}</a>.</p></div>`;
    return shell({ nonce, title: `${team} #${jersey} | ${event.name}`, body });
  }
  if (event.status === "draft") {
    body += `<p class="empty">Clips and photos show up here once our crew has checked them, usually within a day or two after the event.</p>`;
    return shell({ nonce, title: `${team} #${jersey} | ${event.name}`, body });
  }
  body += results({ action: `/m/f/${esc(token)}/checkout`, hidden: {}, label: `${team} #${jersey}`, items, event });
  if (eventLink) body += `<p class="note">Clips with teammates in them, from families who've said yes: <a href="${esc(eventLink)}">this event's clips page</a>.</p>`;
  return shell({ nonce, title: `${team} #${jersey} | ${event.name}`, body, script: items.length ? TOTAL_SCRIPT : "" });
}

// ── The order page ───────────────────────────────────────────────────────
function orderPage({ nonce, event, order, items = [], state, backTo = null }) {
  let body = evHead(event);
  if (state === "pending") {
    body += `<div class="card"><h2>Confirming your payment</h2><p>This takes a few seconds. The page updates itself; your downloads appear here, and we email you this link.</p></div>`;
    return shell({ nonce, title: `Your order | ${event.name}`, body, refresh: 5 });
  }
  if (state === "expired" || state === "refunded" || state === "cancelled") {
    const words = {
      expired: ["Checkout expired", "This checkout ran out of time and nothing was charged."],
      refunded: ["Refunded", "This order was refunded, so its downloads are closed."],
      cancelled: ["Checkout cancelled", "Nothing was charged. To pick again, go back to the event page, or open your family link from its email."],
    }[state];
    body += `<div class="card"><h2>${words[0]}</h2><p>${words[1]}</p>${backTo ? `<div class="row"><a class="pill pill-line" href="${esc(backTo)}">Back to the event page</a></div>` : ""}</div>`;
    return shell({ nonce, title: `Your order | ${event.name}`, body });
  }
  const rows = items
    .map((it, i) => {
      const name = `${it.kind === "clip" ? "Clip" : "Photo"} ${i + 1}`;
      if (it.taken_down) return `<li class="item"><p class="gone">${esc(name)} was taken down at a family's request. Email <a href="mailto:${esc(helpEmail())}">${esc(helpEmail())}</a> for a refund on it.</p></li>`;
      return `<li class="item">${it.poster_url ? `<div class="frame"><img src="${esc(it.poster_url)}" alt="${esc(name)}" loading="lazy"></div>` : ""}<div class="dl"><span>${esc(name)}</span><a class="pill pill-green" href="${esc(it.download_url)}">Download</a></div></li>`;
    })
    .join("");
  const keep = order.emailed_at ? "we've emailed you this page's link so you can come back" : "bookmark this page: it's how you come back";
  body += `<div class="card"><h2>Your downloads</h2><p>Paid ${esc(dollars(order.amount_cents))}${order.mode === "test" ? " (test mode: no real charge)" : ""}. Full quality, no watermark. Download links refresh each time you open this page, and ${keep}.</p></div>
<ul class="items">${rows}</ul>`;
  return shell({ nonce, title: `Your order | ${event.name}`, body });
}

function messagePage({ nonce, title, text, link = null, linkText = "" }) {
  const body = `<h1 class="ev-name">${esc(title)}</h1><p class="lede">${esc(text)}</p>${link ? `<div class="row"><a class="pill pill-line" href="${esc(link)}">${esc(linkText)}</a></div>` : ""}`;
  return shell({ nonce, title: `${title} | Subject Medias`, body });
}

module.exports = { esc, helpEmail, dateRange, dollars, length, CHOICES, AGES, eventGatePage, eventPage, consentPage, consentSentPage, confirmPage, familyPage, orderPage, messagePage, TOTAL_SCRIPT };
