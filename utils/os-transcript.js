// The Operational Transcript as a page — the same look as the public samples
// (public/sample-transcript-*.html): white paper, the lane color down the
// spine, Fraunces headings, the five-pillar radar, the ranked action plan.
// Every value is escaped. No scripts.

"use strict";

const O = require("./os");

function h(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function dateWords(iso) {
  const d = new Date(iso || Date.now());
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "America/New_York" });
}
function quarter(iso) {
  const d = new Date(iso || Date.now());
  return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
}

function radar(vertical, pillars, color) {
  const cx = 170, cy = 170, R = 128;
  const pt = (i, r) => {
    const a = (-90 + i * 72) * (Math.PI / 180);
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const ring = (f) => O.PILLARS.map((_, i) => pt(i, R * f).map((n) => n.toFixed(1)).join(",")).join(" ");
  const shape = O.PILLARS.map((k, i) => pt(i, (R * Math.max(0, Math.min(100, (pillars[k] || {}).score || 0))) / 100).map((n) => n.toFixed(1)).join(",")).join(" ");
  const axes = O.PILLARS.map((_, i) => { const [x, y] = pt(i, R); return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="rgba(26,22,19,.12)"/>`; }).join("");
  const labels = O.PILLARS.map((k, i) => {
    const [x, y] = pt(i, R + 22);
    const anchor = Math.abs(x - cx) < 8 ? "middle" : x > cx ? "start" : "end";
    return `<text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="${anchor}" font-size="12" font-family="Inter,Arial,sans-serif" font-weight="600" fill="#3B3530">${h(O.PILLAR_SHORT[k])}</text>`;
  }).join("");
  return `<svg class="radar-svg" viewBox="-40 -10 420 360" role="img" aria-label="Five-pillar radar">
${[0.25, 0.5, 0.75, 1].map((f) => `<polygon points="${ring(f)}" fill="none" stroke="rgba(26,22,19,.12)"/>`).join("")}${axes}
<polygon points="${shape}" fill="${color}" fill-opacity=".18" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>${labels}</svg>`;
}

// which: "approved" (what the client sees) or "draft" (preview in the app).
function renderTranscript(build, { which = "approved", nonce = "" } = {}) {
  const v = build.vertical;
  const lane = O.VERTICALS[v] || O.VERTICALS["personal-brand"];
  const color = lane.color;
  const t = which === "draft" ? build.transcript_draft : build.transcript;
  const pillars = build.pillars || (build.score_draft && build.score_draft.pillars) || {};
  const sec = O.SECTIONS[v] || O.SECTIONS["personal-brand"];
  const cols = O.LINE_COLUMNS[v] || O.LINE_COLUMNS["personal-brand"];
  const issued = which === "draft" ? new Date().toISOString() : build.transcript_approved_at;
  const id = "OT-" + String(build.id || "").replace(/-/g, "").slice(0, 8).toUpperCase();
  const name = O.displayName(build.intake, build.name);
  const num = (i) => String(i + 1).padStart(2, "0");
  const total = O.totalScore(pillars);
  const weak = O.weakest(pillars);

  const legend = O.PILLARS.map((k) => {
    const p = pillars[k] || { score: 0 };
    const b = O.band(p.score);
    return `<div class="row"><span class="name">${h(O.pillarName(v, k))}</span><span class="score">${h(p.score)} / 100</span><span class="grade">${h(b.name)}</span></div>${p.evidence ? `<p class="ev"><b>Evidence:</b> ${h(p.evidence)}${p.gap ? ` <b>Gap:</b> ${h(p.gap)}` : ""}</p>` : ""}`;
  }).join("");

  const body = !t
    ? `<p class="empty">No transcript yet.</p>`
    : `
<section class="tr-section"><span class="section-num">01 · ${h(sec[0])}</span><h2>The one-paragraph read.</h2><div class="exec-summary"><p>${h(t.executive_summary)}</p></div></section>
<section class="tr-section"><span class="section-num">02 · ${h(sec[1])}</span><h2>Where the operation grades against the standard.</h2><div class="radar-wrap">${radar(v, pillars, color)}<div class="radar-legend">${legend}</div></div><p>Total ${h(total)} / 500.${weak ? ` Weakest pillar: <b>${h(O.pillarName(v, weak))}</b>. Fix this first.` : ""}</p></section>
<section class="tr-section"><span class="section-num">03 · ${h(sec[2])}</span><h2>Each line, against the standard.</h2>${
        t.lines && t.lines.length
          ? `<table class="tr-table"><thead><tr><th>${h(cols[0])}</th><th>${h(cols[1])}</th><th>${h(cols[2])}</th></tr></thead><tbody>${t.lines.map((l) => `<tr><td>${h(l.name)}${l.note ? `<div class="note">${h(l.note)}</div>` : ""}</td><td>${h(l.figure || "—")}</td><td><span class="pill">${h(l.standing || "—")}</span></td></tr>`).join("")}</tbody></table>`
          : `<p>Not in the intake.</p>`
      }</section>
<section class="tr-section"><span class="section-num">04 · ${h(sec[3])}</span><h2>${v === "authority" ? "What's missing from the record." : "Money already on the table, not yet claimed."}</h2>${
        t.recovery && t.recovery.length
          ? `<table class="tr-table"><thead><tr><th>Opportunity</th><th>Value</th><th>Ease</th></tr></thead><tbody>${t.recovery.map((r) => `<tr><td>${h(r.title)}${r.note ? `<div class="note">${h(r.note)}</div>` : ""}</td><td>${h(r.value || "—")}</td><td>${h(r.ease)}</td></tr>`).join("")}</tbody></table>`
          : `<p>Not in the intake.</p>`
      }</section>
<section class="tr-section"><span class="section-num">05 · ${h(sec[4])}</span><h2>${h(sec[4])}.</h2><p>${h(t.roster || "Not in the intake.")}</p></section>
<section class="tr-section"><span class="section-num">06 · ${h(sec[5])}</span><h2>Next quarter's build order.</h2>${(t.path || []).map((p) => `<p><strong>${h(p.label)}:</strong> ${h(p.text)}</p>`).join("") || "<p>—</p>"}</section>
<section class="tr-section"><span class="section-num">07 · ${h(sec[6])}</span><h2>This month's priority list.</h2><ul class="action-list">${(t.actions || []).map((a, i) => `<li><span class="rank">${i + 1}</span><div class="action-body"><strong>${h(a.title)}</strong><span>${h(a.detail)}</span></div><span class="owner">Owner: ${h(a.owner)}</span></li>`).join("")}</ul></section>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>Operational Transcript · ${h(name)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,600;1,9..144,500&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<style nonce="${h(nonce)}">
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:Inter,-apple-system,"Segoe UI",Arial,sans-serif;background:#F5F1EA;color:#1A1613;line-height:1.6;-webkit-font-smoothing:antialiased}
h1,h2{font-family:Fraunces,Georgia,serif;font-weight:600;letter-spacing:-.015em}
.strip{background:#B8843B;color:#fff;text-align:center;font:600 13px/1.4 Inter,Arial,sans-serif;padding:8px 16px}
.doc{max-width:900px;margin:0 auto;padding:clamp(1.5rem,5vw,3.5rem) clamp(1.1rem,3vw,2.5rem);background:#fff;border-left:6px solid ${h(color)};min-height:100vh}
.hdr{display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;padding-bottom:1.3rem;border-bottom:2px solid #1A1613;margin-bottom:1.8rem}
.brand{font-family:Fraunces,Georgia,serif;font-size:1.2rem}.brand span{color:#6E655C}
.meta{text-align:right;font-size:.72rem;color:#6E655C;letter-spacing:.04em}
h1{font-size:clamp(1.9rem,4vw,2.6rem);line-height:1.05;margin-bottom:.4rem}h1 em{font-style:italic;font-weight:500;color:${h(color)}}
.subject{font-size:.9rem;color:#6E655C;margin-bottom:2rem;padding-bottom:1rem;border-bottom:1px solid rgba(26,22,19,.12)}
.section-num{display:inline-block;font-family:Fraunces,Georgia,serif;font-size:.85rem;color:${h(color)};letter-spacing:.06em;margin-bottom:.4rem;font-weight:500}
.tr-section{margin-bottom:2.4rem;padding-bottom:1.8rem;border-bottom:1px solid rgba(26,22,19,.12)}.tr-section:last-of-type{border-bottom:0}
.tr-section h2{font-size:1.45rem;margin-bottom:1rem}.tr-section p{color:#3B3530;margin-bottom:.8rem;font-size:.95rem}
.exec-summary{background:#EBE4D6;padding:1.3rem;border-radius:8px}.exec-summary p{color:#1A1613;font-family:Fraunces,Georgia,serif;font-size:1.05rem;line-height:1.5;margin:0}
.radar-wrap{display:grid;grid-template-columns:1fr 1fr;gap:1.6rem;align-items:start;margin:1rem 0}@media(max-width:720px){.radar-wrap{grid-template-columns:1fr}}
.radar-svg{width:100%;max-width:360px;margin:0 auto;display:block}
.radar-legend .row{display:grid;grid-template-columns:1fr auto auto;gap:.6rem;align-items:center;padding:.45rem .7rem;background:#EBE4D6;border-radius:6px;font-size:.85rem;margin-top:.5rem}
.radar-legend .name{font-weight:600}.radar-legend .score{color:${h(color)};font-weight:600}.radar-legend .grade{font-family:Fraunces,Georgia,serif;font-weight:600}
.radar-legend .ev{font-size:.78rem;color:#6E655C;margin:.3rem .2rem 0}
.tr-table{width:100%;border-collapse:collapse;margin:.6rem 0;font-size:.86rem}
.tr-table th{text-align:left;background:#EBE4D6;padding:.6rem .8rem;font-size:.7rem;letter-spacing:.1em;text-transform:uppercase}
.tr-table td{padding:.75rem .8rem;color:#3B3530;border-bottom:1px solid rgba(26,22,19,.12);vertical-align:top}.tr-table td:first-child{font-weight:600;color:#1A1613}
.note{font-weight:400;color:#6E655C;font-size:.8rem;margin-top:.2rem}
.pill{display:inline-block;padding:.12rem .5rem;border-radius:4px;font-size:.72rem;font-weight:700;background:rgba(184,132,59,.18);color:#8A5F21}
.action-list{list-style:none}.action-list li{display:grid;grid-template-columns:2.2rem 1fr auto;gap:.9rem;padding:.9rem 0;border-bottom:1px solid rgba(26,22,19,.12);align-items:center}
.rank{font-family:Fraunces,Georgia,serif;font-size:1.6rem;font-weight:600;color:${h(color)};line-height:1}
.action-body{display:flex;flex-direction:column;gap:.15rem}.action-body span{font-size:.8rem;color:#6E655C}
.owner{font-size:.72rem;padding:.3rem .55rem;background:#EBE4D6;border-radius:4px;white-space:nowrap}
.foot{margin-top:2.4rem;padding-top:1.2rem;border-top:2px solid #1A1613;font-size:.78rem;color:#6E655C}
.empty{color:#6E655C}
</style></head><body>
${which === "draft" ? `<div class="strip">Draft. Nobody outside the team sees this until it's approved.</div>` : ""}
<main class="doc">
<div class="hdr"><div class="brand">TOJ <span>Operational Transcript™</span></div><div class="meta"><div>Report ID: ${h(id)}</div><div>Issued: ${h(dateWords(issued))}</div><div>Quarter: ${h(quarter(issued))}</div></div></div>
<h1>Standing of the <em>operation</em></h1>
<p class="subject"><b>${h(name)}</b> · ${h(lane.label)}</p>
${body}
<div class="foot">© ${new Date(issued || Date.now()).getUTCFullYear()} Trail of Joy Management Group, LLC · Scored against the five pillars of the TOJ Standard. Not a prediction or a guarantee.</div>
</main></body></html>`;
}

module.exports = { renderTranscript, radar };
