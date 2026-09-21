import assert from "node:assert/strict";
import test from "node:test";

import { portfolioSlaStatus } from "../services/enterpriseAssurance.service.js";

test("portfolio SLA reports overdue outcomes, coverage, and review cadence", () => {
  const status = portfolioSlaStatus({
    created_at: "2026-08-01T00:00:00.000Z",
    sla_grace_days: 2,
    minimum_verified_percent: 80,
    review_cadence_days: 30,
  }, [{
    id: "goal-1",
    title: "Launch",
    target_date: "2026-09-10",
    assurance: { state: "off_track" },
  }], new Date("2026-09-21T00:00:00.000Z"));
  assert.equal(status.healthy, false);
  assert.equal(status.verifiedPercent, 0);
  assert.deepEqual(status.exceptions.map((item) => item.type), [
    "outcome_overdue",
    "verified_coverage_below_target",
    "portfolio_review_overdue",
  ]);
});
