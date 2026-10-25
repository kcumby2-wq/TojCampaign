// The run sheet, the upload check and the crew brief (docs/gfs-workflow-sop.md),
// as pure functions: no database. tests/gfs-run-sheet-db.test.js runs them
// through the routes.
//
//   node --test tests/gfs-run-sheet.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");
const G = require("../utils/gfs");

// Girls Flag · Los Angeles: one day, wraps 6 p.m. Pacific (02:00Z the next day).
const LA = { id: "ev1", code: "LosAngeles2026", name: "Girls Flag · Los Angeles", starts_on: "2026-11-21", ends_on: "2026-11-21", wraps_at: "18:00", tz: "America/Los_Angeles", crew_target: 2, city: "Los Angeles", state: "CA", venue: null, reviewed_at: null };
LA.ends_at = G.endsAt(LA);
const at = (iso) => Date.parse(iso);
const stage = (sheet, key) => sheet.find((s) => s.key === key);
const SCREENED = { status: "active", contract_signed_on: "2026-09-01", background_check_on: "2026-09-01", safety_training_on: "2026-09-01", age_checked_on: "2026-09-01", tier: "adult" };

test("twelve stages, in order, with deadlines from the start (before) and the wrap (after)", () => {
  const sheet = G.runSheet(LA, {}, at("2026-10-01T12:00:00Z"));
  assert.deepEqual(sheet.map((s) => s.key), ["staff", "screened", "crew", "storefront", "roster", "brief", "capture", "uploads", "tags", "sale", "deliverables", "review"]);
  const due = Object.fromEntries(sheet.map((s) => [s.key, s.due_at]));
  // Day deadlines are local midnights: 07:00Z while Pacific is on daylight
  // time (until Nov 1), 08:00Z after. Hour deadlines count from the start
  // (Nov 21, 00:00 Pacific = 08:00Z) or the wrap (18:00 Pacific = Nov 22, 02:00Z).
  assert.equal(due.staff, "2026-10-07T07:00:00.000Z");
  assert.equal(due.screened, "2026-10-31T07:00:00.000Z");
  assert.equal(due.crew, "2026-11-07T08:00:00.000Z");
  assert.equal(due.storefront, "2026-11-14T08:00:00.000Z");
  assert.equal(due.roster, "2026-11-18T08:00:00.000Z");
  assert.equal(due.brief, "2026-11-19T08:00:00.000Z");
  assert.equal(due.capture, "2026-11-22T02:00:00.000Z");
  assert.equal(due.uploads, "2026-11-22T14:00:00.000Z");
  assert.equal(due.tags, "2026-11-23T02:00:00.000Z");
  assert.equal(due.sale, "2026-11-24T02:00:00.000Z");
  assert.equal(due.review, "2026-12-06T02:00:00.000Z");
});

test("day deadlines fall on the same local date across a daylight-saving change", () => {
  // Chicago, Sat Mar 20, 2027: clocks went forward on Mar 14.
  const ev = { ...LA, code: "Chicago2027", starts_on: "2027-03-20", ends_on: "2027-03-20", tz: "America/Chicago" };
  ev.ends_at = G.endsAt(ev);
  const due = Object.fromEntries(G.runSheet(ev, {}, at("2027-01-01T12:00:00Z")).map((s) => [s.key, s.due_at]));
  assert.equal(due.staff, "2027-02-03T06:00:00.000Z", "Feb 3, midnight CST");
  assert.equal(due.crew, "2027-03-06T06:00:00.000Z", "Mar 6, midnight CST, not 11 p.m. the day before");
  assert.equal(due.storefront, "2027-03-13T06:00:00.000Z", "Mar 13, the day before the change");
  assert.equal(due.roster, "2027-03-17T05:00:00.000Z", "72 hours before midnight CDT on the 20th");
  assert.equal(due.review, "2027-04-03T23:00:00.000Z", "Apr 3, 6 p.m. CDT");
});

test("a stage is soon a week ahead and late after its deadline; after-event stages wait for the wrap", () => {
  const early = G.runSheet(LA, {}, at("2026-09-20T12:00:00Z"));
  assert.equal(stage(early, "staff").status, "upcoming", "8 weeks out: not yet");
  const week = G.runSheet(LA, {}, at("2026-10-02T12:00:00Z"));
  assert.equal(stage(week, "staff").status, "soon");
  const late = G.runSheet(LA, {}, at("2026-10-25T16:00:00Z"));
  assert.equal(stage(late, "staff").status, "late");
  assert.equal(stage(late, "screened").status, "soon");
  // The night before: uploads are due in under a week, but the stop hasn't wrapped.
  const eve = G.runSheet(LA, {}, at("2026-11-20T12:00:00Z"));
  assert.equal(stage(eve, "uploads").status, "upcoming");
  assert.equal(stage(eve, "sale").status, "upcoming");
  const after = G.runSheet(LA, {}, at("2026-11-22T20:00:00Z"));
  assert.equal(stage(after, "uploads").status, "late", "18 hours after the wrap with no log");
  assert.equal(stage(after, "tags").status, "soon");
  // Once the stop has started, staffing, screening, the crew and the brief
  // can't be done any more: missed, not nagged. The roster and the storefront
  // are still needed for tags and sales.
  for (const k of ["staff", "screened", "crew", "brief"]) assert.equal(stage(after, k).status, "missed", k);
  for (const k of ["storefront", "roster"]) assert.equal(stage(after, k).status, "late", k);
  const sales = G.runSheet(LA, {}, at("2026-11-22T20:00:00Z")).filter((s) => G.stageIsMine(s, { role: "member" }, LA, "mia@example.com") && (s.status === "late" || s.status === "soon"));
  assert.deepEqual(sales.map((s) => s.key), ["storefront", "roster", "uploads", "tags", "sale"]);
});

test("done tests: staffing, screening, uploads, tags and getting clips out", () => {
  const now = at("2026-11-25T12:00:00Z");
  const creators = new Map([["c1", { ...SCREENED, id: "c1" }], ["c2", { ...SCREENED, id: "c2", background_check_on: null }]]);
  const crew = [{ creator_id: "c1", role: "lead", status: "confirmed" }, { creator_id: "c2", role: "shooter", status: "invited" }];
  let sheet = G.runSheet(LA, { crew, creators }, now);
  assert.equal(stage(sheet, "staff").done, true, "two on site, with a lead");
  assert.equal(stage(sheet, "screened").done, false);
  assert.match(stage(sheet, "screened").note, /1 creator not screened/);
  creators.get("c2").background_check_on = "2026-09-01";
  sheet = G.runSheet(LA, { crew, creators }, now);
  assert.equal(stage(sheet, "screened").done, true);

  const uploads = [
    { game: "Stars_vs_Flash_20261121", angle: "Sideline", final_whistle_at: "2026-11-21T20:00:00Z", uploaded_at: "2026-11-21T22:00:00Z" },
    { game: "Stars_vs_Flash_20261121", angle: "EndZone", final_whistle_at: "2026-11-21T20:00:00Z", uploaded_at: "2026-11-22T11:00:00Z" },
  ];
  sheet = G.runSheet({ ...LA, tags_approved_at: "2026-11-22T12:00:00Z" }, { uploads, counts: { shot: 40, unmatched: 0, tagged: 30, edited: 30, approved: 30, listed: 30, delivered: 30 } }, now);
  assert.equal(stage(sheet, "capture").done, true);
  assert.equal(stage(sheet, "uploads").done, true);
  assert.match(stage(sheet, "uploads").note, /1 file over 12 hours/);
  assert.equal(stage(sheet, "tags").done, true);
  assert.equal(stage(sheet, "sale").done, true);
  // Anything still in the edit, waiting for approval, approved but not out,
  // or in a file nobody marked, keeps the stage open.
  for (const counts of [{ approved: 30, tagged: 35, edited: 30, listed: 30, delivered: 30 }, { approved: 25, tagged: 30, edited: 30, listed: 25, delivered: 25 }, { approved: 30, tagged: 30, edited: 30, listed: 20, delivered: 10, not_out: 10 }, { approved: 30, tagged: 30, edited: 30, listed: 30, delivered: 30, to_send: 2 }]) {
    assert.equal(stage(G.runSheet(LA, { counts }, now), "sale").done, false, JSON.stringify(counts));
  }
  // A held clip can't go out, so it doesn't keep the stage open (not_out
  // counts only clips that aren't held or taken down).
  const heldOne = G.runSheet(LA, { counts: { approved: 2, tagged: 2, edited: 2, listed: 1, delivered: 1, held: 1, not_out: 0 } }, now);
  assert.equal(stage(heldOne, "sale").done, true);
  const unmatched = G.runSheet({ ...LA, tags_approved_at: "2026-11-22T12:00:00Z" }, { counts: { shot: 40, unmatched: 3 } }, now);
  assert.equal(stage(unmatched, "tags").done, false);
  assert.match(stage(unmatched, "tags").note, /3 to review/);
});

test("the review is tracked only once migration 029 adds it; capture and Schedule C never go to Needs you", () => {
  const { reviewed_at, ...pre029 } = LA;
  const before = stage(G.runSheet(pre029, {}, at("2026-12-10T12:00:00Z")), "review");
  assert.equal(before.actionable, false);
  assert.match(before.note, /migration 029/);
  const after = stage(G.runSheet(LA, {}, at("2026-12-10T12:00:00Z")), "review");
  assert.equal(after.actionable, true);
  assert.equal(after.status, "late");
  assert.equal(stage(G.runSheet({ ...LA, reviewed_at: "2026-12-05T00:00:00Z" }, {}, at("2026-12-10T12:00:00Z")), "review").done, true);
  const sheet = G.runSheet(LA, {}, at("2026-12-10T12:00:00Z"));
  assert.equal(stage(sheet, "capture").actionable, false);
  assert.equal(stage(sheet, "deliverables").actionable, false);
});

test("whose Needs you a stage goes to", () => {
  const sheet = G.runSheet(LA, {}, at("2026-12-10T12:00:00Z"));
  const owner = { owner: true, role: "owner" }, approver = { role: "approver" }, director = { role: "member" }, viewer = { role: "viewer" };
  const mine = (access, ev, email) => sheet.filter((s) => G.stageIsMine(s, access, ev, email)).map((s) => s.key);
  assert.deepEqual(mine(owner, LA), ["staff", "screened", "crew", "storefront", "roster", "brief", "uploads", "tags", "sale", "review"]);
  assert.deepEqual(mine(approver, LA), ["storefront", "sale"]);
  assert.deepEqual(mine(director, LA, "mia@example.com"), ["staff", "crew", "storefront", "roster", "brief", "uploads", "tags", "sale"], "no director yet: any director in the region");
  assert.deepEqual(mine(director, { ...LA, director_email: "mia@example.com" }, "mia@example.com").length, 8);
  assert.deepEqual(mine(director, { ...LA, director_email: "joe@example.com" }, "mia@example.com"), [], "someone else's stop");
  assert.deepEqual(mine(viewer, LA), []);
});

test("the upload check: angles, late files, missing whistles, unusable files", () => {
  const k = G.uploadCheck([
    { game: "A_vs_B_20261121", angle: "Sideline", final_whistle_at: "2026-11-21T20:00:00Z", uploaded_at: "2026-11-22T10:30:00Z" },
    { game: "A_vs_B_20261121", angle: "Story", final_whistle_at: "2026-11-21T20:00:00Z", uploaded_at: "2026-11-21T22:00:00Z" },
    { game: "C_vs_D_20261121", angle: "Sideline", final_whistle_at: null, uploaded_at: "2026-11-21T22:00:00Z" },
    { game: "C_vs_D_20261121", angle: "EagleEye", final_whistle_at: null, usable: false },
    { game: "E_vs_F_20261121", angle: "Sideline", final_whistle_at: "2026-11-21T20:00:00Z", uploaded_at: "2026-11-21T21:00:00Z" },
    { game: "E_vs_F_20261121", angle: "EndZone", final_whistle_at: "2026-11-21T20:00:00Z", uploaded_at: "2026-11-21T21:00:00Z" },
  ]);
  assert.equal(k.games, 3);
  assert.equal(k.missing_angle, 1, "a Story camera isn't a wide angle; Sideline with Eagle Eye counts as two");
  assert.deepEqual(k.issues.find((g) => g.game === "A_vs_B_20261121").missing, ["EndZone"]);
  assert.equal(k.late_files, 1);
  assert.equal(k.hours_late, 2.5);
  assert.equal(k.no_whistle, 1);
  assert.equal(k.unusable, 1);
  assert.ok(!k.issues.some((g) => g.game === "E_vs_F_20261121"), "a clean game isn't listed");
  assert.deepEqual(G.uploadCheck([]), { games: 0, missing_angle: 0, late_files: 0, late_games: 0, hours_late: 0, no_whistle: 0, unusable: 0, issues: [] });
});

test("the crew brief: crew, pre-sold and held athletes by team and jersey only, the standards, where help goes", () => {
  const roster = [
    { team: "LA Stars", jersey: 11, position: "WR", priority: true, consent_capture: true },
    { team: "LA Stars", jersey: 7, priority: true, consent_capture: false },
    { team: "LA Stars", jersey: 23, consent_capture: true, do_not_publish: true },
    { team: "OC Flash", jersey: 3, priority: true, consent_capture: true },
    { team: "OC Flash", jersey: null, priority: true, consent_capture: true },
  ];
  const b = G.crewBrief(LA, {
    crew: [{ name: "Ana Ruiz", role_name: "Lead", status: "confirmed" }, { name: "Ty Teen", role_name: "Shooter", status: "invited", youth: true }, { name: "Gone", role_name: "Shooter", status: "removed" }],
    director: { name: "Mia D", email: "mia@example.com" },
    roster,
    help: { email: "support@groundfloorsports.com", phone: "(213) 555-0100", page: "https://media.groundfloorsports.com/e/LosAngeles2026" },
  });
  assert.match(b.text, /^CREW BRIEF · Girls Flag · Los Angeles\nSat, Nov 21, 2026 · wraps 6:00 PM PST · Los Angeles, CA\n/);
  assert.match(b.text, /- Ana Ruiz · Lead\n- Ty Teen · Shooter \(youth creator\) · not confirmed yet\nDirector: Mia D · mia@example\.com/);
  assert.doesNotMatch(b.text, /Gone/, "a removed crew member isn't on it");
  assert.match(b.text, /COVER FIRST[^\n]*\n- LA Stars: #11 WR\n- OC Flash: #3, 1 with no number on the roster\n/);
  assert.match(b.text, /NO CLIPS OF THESE ATHLETES[^\n]*\n- LA Stars: #7, #23\n/, "a pre-sold athlete who's held is listed as held, not as pre-sold");
  assert.match(b.text, /team names exactly: LA Stars, OC Flash\./);
  assert.match(b.text, /https:\/\/media\.groundfloorsports\.com\/e\/LosAngeles2026/);
  assert.match(b.text, /support@groundfloorsports\.com, or text \(213\) 555-0100/);
  assert.deepEqual(b.counts, { crew: 2, teams: 2, priority: 3, holds: 2 });
  const quiet = G.crewBrief(LA, { roster: [{ team: "LA Stars", jersey: 1, consent_capture: true }] });
  assert.doesNotMatch(quiet.text, /COVER FIRST|NO CLIPS OF/, "empty sections are left out");
  assert.match(quiet.text, /Nobody is on the crew yet/);
});
