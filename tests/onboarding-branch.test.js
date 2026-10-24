// Onboarding branches — SportsClippers replaced Flippa Highlights (Oct 2026).
// Old forms and saved links may still send 'flippa-highlights': it is accepted,
// stored as 'sportsclippers', and still matched when the CRM filters.
//
//   node --test tests/onboarding-branch.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");

const router = require("../routes/onboarding");

test("sportsclippers is a valid branch and flippa-highlights is not", () => {
  assert.ok(router._VALID_BRANCHES.has("sportsclippers"));
  assert.ok(!router._VALID_BRANCHES.has("flippa-highlights"));
});

test("the old name is stored under the new one", () => {
  assert.equal(router._normalizeBranch("flippa-highlights"), "sportsclippers");
  assert.equal(router._normalizeBranch("sportsclippers"), "sportsclippers");
  assert.equal(router._normalizeBranch("pylon"), "pylon");
});

test("an empty branch stays empty", () => {
  assert.equal(router._normalizeBranch(undefined), null);
  assert.equal(router._normalizeBranch(null), null);
  assert.equal(router._normalizeBranch(""), null);
});

test("filtering by sportsclippers also matches rows saved under the old name", () => {
  assert.deepEqual(router._branchesFor("sportsclippers"), [
    "sportsclippers",
    "flippa-highlights",
  ]);
  assert.deepEqual(router._branchesFor("pylon"), ["pylon"]);
});
