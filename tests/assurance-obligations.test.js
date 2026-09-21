import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("obligations reuse outcome evidence and require evidence before satisfaction", () => {
  const migration = read("migrations/20260921_enterprise_completion.sql");
  const service = read("services/assuranceObligation.service.js");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.assurance_obligations/);
  assert.match(migration, /REFERENCES public\.goal_assurance_evidence\(workspace_id, goal_id, id\)/);
  assert.match(service, /Link evidence before satisfying this obligation/);
  assert.match(service, /item\.goal_id=obligation\.goal_id/);
});

test("evidence packs include obligations and their linked evidence in signed receipts", () => {
  const receipt = read("services/decisionOutcome.service.js");
  const routes = read("routes/assurance.routes.js");
  assert.match(receipt, /obligations: \(outcomeDetail\.obligations \|\| \[\]\)/);
  assert.match(routes, /commitments\/:id\/evidence-pack/);
  assert.match(routes, /generateOutcomeReceipt/);
});
