// Ground Floor Sports · the asset library: the pure rules behind each digital
// asset's record (routes/gfs-assets.js stores, public/app/gfs-assets.js
// shows). No network, no database. Migration 027 enforces the same rules in
// Postgres (gfs_asset_blocks and the gates), so a bug here can't put an asset
// live without the permissions it needs.
//
// Where each rule comes from (October 2026 drafts):
//   GFS World Pipeline Developer Spec v1.2   rules 1-9, §4.3, §7, §9, §9A
//   GFS Narrative NFT Terms v1.0             §3 (when we mint), §4, §6 (72 hours)
//   GFS Digital Collectibles Terms v1.1      §1 (18 and older), §2, §7
//   GFS Digital Scout Agreement v1.5         §8 (GFS owns the footage), B-2
//   Pylon × GFS Partnership Agreement        Schedule I-2 (venue permission), I-3

"use strict";

const G = require("./gfs");
const { hasContact } = require("./chat");

const KINDS = Object.freeze({
  edit: {
    name: "Edit",
    what: "A recap, montage, feature, reel or photo set made from a stop's footage.",
    athletes: "many",
    formats: ["recap", "montage", "feature", "reel", "photos", "interview"],
    live: ["gfs_storage", "pylon_channels", "sportsclippers"],
    liveLabel: "Out",
    checklist: "Checked against the stop's keep-out list, and every athlete it features has capture and marketing consent.",
    rights: "GFS owns the footage it captures (Scout Agreement §8). Pylon posts only what an approver clears, and families get footage through family-only links unless the guardian chose public display.",
  },
  venue_world: {
    name: "Venue World",
    what: "A 3D World of the venue as it was dressed for the stop. No people in it, ever.",
    athletes: "none",
    formats: [],
    live: ["gfs_storage"],
    liveLabel: "Published",
    checklist: "No people in any view, no legible names or faces on signage, no jerseys with names, and no sponsor marks without a licence.",
    rights: "Worlds GFS builds belong to GFS (Scout Agreement §8). A capture with a person in it is rejected, not blurred. School stadiums are never sold.",
  },
  moment: {
    name: "3D/4D Moment",
    what: "A 3D view, or a 4D one that moves through the play, of one athlete's moment. Made only for their family.",
    athletes: "one",
    formats: ["3d", "4d"],
    live: ["family_library"],
    liveLabel: "Delivered",
    checklist: "Every other player is blurred or masked, it's labeled “AI reconstruction — not game film” where it's reconstructed, and it goes to the family's library only.",
    rights: "Made only for the athlete's parent or guardian (or the athlete at 18) and delivered to their library: never sold to anyone else, never shared publicly, never used to grade a player or shown to a college (Spec rule 6, §9).",
  },
  world_pass: {
    name: "World Pass",
    what: "A numbered collectible edition of a published venue World, sold at a fixed price to buyers 18 and older.",
    athletes: "none",
    formats: [],
    live: ["gfs_store"],
    liveLabel: "On sale",
    checklist: "The World shows no athletes, coaches, officials or spectators, the price is fixed, and it isn't a school venue.",
    rights: "A keepsake, not an investment: no auctions, no dynamic prices, never split into fractions (Collectibles Terms §2, §3). Pylon's marks belong to Pylon.",
  },
  narrative_nft: {
    name: "Narrative NFT",
    what: "The record of one verified clip or photo of one athlete. The family holds it until the athlete is 18.",
    athletes: "one",
    formats: [],
    live: ["ledger"],
    liveLabel: "Minted",
    checklist: "It's the original file, verified, tagged to this one athlete, and it isn't a 3D World, an AI replay or sponsor product content.",
    rights: "Never sold or transferred. The ledger holds five fields and nothing about the athlete, nothing goes on a public chain while the holder is a minor, and a withdrawal takes it down everywhere within 72 hours (NFT Terms §4-§6). GFS keeps the copyright.",
  },
  brand: {
    name: "Brand asset",
    what: "A graphic, template, LUT, overlay, logo or sponsor asset.",
    athletes: "none",
    formats: ["graphic", "template", "lut", "overlay", "logo", "sponsor"],
    live: ["gfs_storage", "link"],
    liveLabel: "In use",
    checklist: "Pylon's marks are used for Pylon work only, any sponsor's marks are licensed, and there are no school, state association or college marks in anything sold.",
    rights: "Pylon's marks are licensed for Pylon work only (Schedule I-3). A sponsor's marks need the sponsor's licence.",
  },
});
const KIND_KEYS = Object.freeze(Object.keys(KINDS));
const FORMAT_NAMES = Object.freeze({ recap: "Recap", montage: "Montage", feature: "Feature", reel: "Reel", photos: "Photo set", interview: "Interview", "3d": "3D", "4d": "4D", graphic: "Graphic", template: "Template", lut: "LUT or preset", overlay: "Overlay", logo: "Logo", sponsor: "Sponsor asset" });
const STAGES = Object.freeze(["draft", "review", "approved", "live", "retired"]);
const STAGE_NAMES = Object.freeze({ draft: "Draft", review: "In review", approved: "Approved", live: "Live", retired: "Retired" });
const LOCATIONS = Object.freeze({
  gfs_storage: "GFS storage",
  world_labs: "World Labs",
  family_library: "Family's GFS library",
  gfs_store: "GFS store",
  sportsclippers: "SportsClippers",
  pylon_channels: "Pylon's channels",
  ledger: "Narrative NFT ledger",
  link: "Link",
});
const RETIRE_REASONS = Object.freeze({ withdrawn: "Consent withdrawn", takedown: "Takedown", replaced: "Replaced", expired: "Expired", mistake: "Made in error" });

// The checks a person records, who may record them, and for which kinds.
const CHECKS = Object.freeze({
  venue_permission: { name: "The venue's signed permission is on file (Pylon I-2)", role: "member", kinds: ["venue_world"] },
  deidentified: { name: "Every other player is blurred or masked, and a person checked it", role: "approver", kinds: ["moment"] },
  tier4: { name: "The family's Tier 4 consent is on the CFR record", role: "approver", kinds: ["moment"] },
  mint_consent: { name: "The signed Consent to Mint is on file (parent, with the athlete's assent at 13 to 17)", role: "owner", kinds: ["narrative_nft"] },
  marks_licensed: { name: "The sponsor's licence for its marks is on file", role: "approver", kinds: null },
});
const CHECK_KEYS = Object.freeze(Object.keys(CHECKS));
function checksFor(asset) {
  return CHECK_KEYS.filter((k) => (CHECKS[k].kinds ? CHECKS[k].kinds.includes(asset.kind) : !!asset.sponsor_marks));
}

const TITLE_MAX = 80;
const NOTE_MAX = 300;
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const LINK_RE = /^https:\/\/[^\s"<>]+$/;
const SHA_RE = /^[0-9a-f]{64}$/;

// Where a file is: an ID or a label in the B-5 / J-9 form (no spaces, no
// slashes, so no folder names), or for a brand asset only, an https link.
// Mirrors the gfs_assets checks.
function refProblem(kind, location, ref) {
  if (!location) return ref ? "location_required" : null;
  if (!Object.prototype.hasOwnProperty.call(LOCATIONS, location)) return "location";
  if (ref == null || ref === "") return null;
  if (location === "link") return kind === "brand" && String(ref).length <= 300 && LINK_RE.test(ref) ? null : "link_brand_only";
  return LABEL_RE.test(ref) ? null : "ref";
}
function liveLocationOk(asset) {
  return !!asset.location && KINDS[asset.kind].live.includes(asset.location) && !!asset.ref;
}

// Why an asset can't be approved or go live. Mirrors public.gfs_asset_blocks
// (migration 027). athletes: [{ roster (the roster row now), team, jersey (as
// they were when added) }]. ev: the stop. source: a World Pass's venue World.
function assetBlocks(asset, athletes, ev, source) {
  const out = [];
  const list = athletes || [];
  for (const a of list) {
    const r = a.roster;
    const hold = G.holdReason(r);
    if (hold) out.push(hold + ":" + r.id);
    if ((r.team || null) !== (a.team || null) || (r.jersey || null) !== (a.jersey || null)) out.push("roster_changed:" + r.id);
    if (asset.kind === "moment") {
      if (!r.consent_3d) out.push("no_3d_consent:" + r.id);
      if (G.under13(r)) out.push("under_13:" + r.id);
    } else if (asset.kind === "narrative_nft") {
      if (!r.consent_nft) out.push("no_nft_consent:" + r.id);
    } else if (asset.kind === "edit") {
      if (!r.consent_marketing) out.push("no_marketing_consent:" + r.id);
    }
  }
  if ((asset.kind === "moment" || asset.kind === "narrative_nft") && list.length !== 1) out.push("one_athlete");
  if (asset.kind === "venue_world" && !asset.venue_permission_at) out.push("venue_permission");
  if (asset.kind === "moment") {
    if (!asset.deidentified_at) out.push("deidentified");
    if (!asset.tier4_at) out.push("tier4");
    if (ev && ev.state === "IL") out.push("illinois_hold");
  }
  if (asset.kind === "narrative_nft" && !asset.mint_consent_at) out.push("mint_consent");
  if (asset.sponsor_marks && !asset.marks_licensed_at) out.push("marks_licensed");
  if (asset.kind === "world_pass") {
    if (asset.price_cents == null) out.push("price");
    if (!asset.source_asset_id || !source || source.kind !== "venue_world" || source.stage !== "live") out.push("source_world");
    else if (source.school_venue) out.push("school_venue");
  }
  return out;
}
// Reasons about an athlete: the ones viewers never see.
function athleteReason(code) {
  return String(code).includes(":");
}
function splitBlock(code) {
  const i = String(code).indexOf(":");
  return i < 0 ? { code, row: null } : { code: code.slice(0, i), row: code.slice(i + 1) };
}

// What a person can move the asset to from where it is.
function moves(access, asset) {
  const T = require("./team");
  const rank = (r) => T.ROLE_RANK[r] || 0;
  const role = access && access.owner ? "owner" : access && access.role;
  const atLeast = (r) => rank(role) >= rank(r);
  const out = [];
  if (!atLeast("member")) return out;
  if (asset.stage === "draft") out.push("review");
  if (asset.stage === "review") out.push("draft");
  if (asset.stage === "review" && atLeast("approver")) out.push("approved");
  if (asset.stage === "approved" && atLeast("approver")) out.push("live", "draft");
  if (asset.stage !== "retired") out.push("retired");
  return out;
}
function canCheck(access, check) {
  const T = require("./team");
  if (!access) return false;
  if (CHECKS[check].role === "owner") return !!access.owner;
  return access.owner || T.ROLE_RANK[access.role] >= T.ROLE_RANK[CHECKS[check].role];
}

function cleanTitle(s) {
  return G.clean(s, TITLE_MAX + 1);
}
function textProblem(s, max, field) {
  if (!s) return field + "_required";
  if (s.length > max) return field + "_too_long";
  if (hasContact(s)) return "contact_details";
  return null;
}

module.exports = {
  KINDS,
  KIND_KEYS,
  FORMAT_NAMES,
  STAGES,
  STAGE_NAMES,
  LOCATIONS,
  RETIRE_REASONS,
  CHECKS,
  CHECK_KEYS,
  TITLE_MAX,
  NOTE_MAX,
  SHA_RE,
  checksFor,
  refProblem,
  liveLocationOk,
  assetBlocks,
  athleteReason,
  splitBlock,
  moves,
  canCheck,
  cleanTitle,
  textProblem,
};
