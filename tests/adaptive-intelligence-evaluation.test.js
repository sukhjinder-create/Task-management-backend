import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEvaluationRecord,
  businessCategoryForAction,
  calculateEffectivenessScore,
  capabilityLabel,
  confidenceCalibrationSummary,
  contextContributionLabels,
} from "../adaptive/evaluation/adaptiveIntelligenceEvaluation.service.js";

const workspaceId = "33333333-3333-4333-8333-333333333333";
const actionId = "44444444-4444-4444-8444-444444444444";

test("AIEP translates internal adaptive action data into business-language evaluation records", () => {
  const record = buildEvaluationRecord({
    id: actionId,
    workspace_id: workspaceId,
    source: "adaptive_runtime",
    status: "executed",
    action_type: "notify_user",
    capability_key: "notification.send",
    title: "Blocked task needs attention",
    summary: "Delivery risk detected on a blocked implementation task.",
    explanation: "A blocked task and related meeting decision indicate delivery risk.",
    confidence: 0.82,
    outcome_confidence: 0.77,
    evidence: [{ source: "meeting notes", text: "huddle decision and blocker risk" }],
    created_at: "2026-07-02T06:00:00.000Z",
    executed_at: "2026-07-02T06:20:00.000Z",
    runtime_run: {
      id: "55555555-5555-4555-8555-555555555555",
      event_id: "66666666-6666-4666-8666-666666666666",
      context_summary: { sources: ["meetings", "risk", "project history"] },
      reasoning_summary: "Blocked work should be surfaced.",
      evidence: [{ source: "project history" }],
      started_at: "2026-07-02T06:00:00.000Z",
      completed_at: "2026-07-02T06:01:00.000Z",
    },
    predictions: [
      {
        status: "evaluated",
        prediction_key: "recommendation.accepted",
        predicted_value: { probability: 0.8 },
        actual_value: { accepted: true },
        score: 0.04,
      },
      {
        status: "evaluated",
        prediction_key: "outcome.delivery_health_improves",
        predicted_value: { probability: 0.72 },
        actual_value: { result: { improved: true } },
        causal_summary: { improved: true, delta: 0.18 },
        score: 0.0784,
      },
    ],
    learning_signals: [
      { signal_key: "prediction.accuracy", signal_value: { brierScore: 0.04 }, source: "continuous_evaluation", status: "active" },
    ],
    workflow_runs: [{ id: "77777777-7777-4777-8777-777777777777", status: "completed" }],
    invocations: [{ capability_key: "notification.send", status: "succeeded" }],
    decisions: [{ decision: "executed", created_at: "2026-07-02T06:20:00.000Z" }],
  });

  assert.equal(record.recommendationCategory, "Task delivery assistance");
  assert.ok(record.effectivenessScore > 0.7);
  assert.ok(record.contextSummary.some((item) => item.label === "Meetings"));
  assert.ok(record.contextSummary.some((item) => item.label === "Risk"));
  assert.ok(record.capabilitySummary.some((item) => item.label === "Notify the right people"));
  assert.equal(record.explainability.wouldRecommendAgain, true);
  assert.equal(record.learningSummary.activeSignals, 1);

  const visiblePayload = JSON.stringify({
    recommendationCategory: record.recommendationCategory,
    capabilitySummary: record.capabilitySummary,
    contextSummary: record.contextSummary,
    explainability: record.explainability,
  });
  assert.equal(visiblePayload.includes("notification.send"), false);
  assert.equal(visiblePayload.includes("recommendation.accepted"), false);
});

test("AIEP effectiveness scoring rewards accepted, accurate, completed outcomes without changing recommendation behavior", () => {
  const successful = calculateEffectivenessScore({
    action: { status: "executed", confidence: 0.8 },
    predictions: [{ status: "evaluated", score: 0.03, predicted_value: { probability: 0.8 }, actual_value: { accepted: true } }],
    workflows: [{ status: "completed" }],
    learningSignals: [{ signal_key: "prediction.accuracy", status: "active" }],
  });
  const rejected = calculateEffectivenessScore({
    action: { status: "rejected", confidence: 0.8 },
    predictions: [{ status: "evaluated", score: 0.64, predicted_value: { probability: 0.8 }, actual_value: { accepted: false } }],
    workflows: [{ status: "failed" }],
    learningSignals: [{ signal_key: "recommendation.rejected", status: "active" }],
  });

  assert.ok(successful > rejected);
  assert.ok(successful <= 1 && successful >= 0);
  assert.ok(rejected <= 1 && rejected >= 0);
});

test("AIEP confidence calibration identifies overconfidence and false positives", () => {
  const summary = confidenceCalibrationSummary([
    { status: "evaluated", predicted_value: { probability: 0.9 }, actual_value: { accepted: false }, score: 0.81 },
    { status: "pending", predicted_value: { probability: 0.7 } },
  ]);

  assert.equal(summary.evaluated, 1);
  assert.equal(summary.pending, 1);
  assert.equal(summary.falsePositives, 1);
  assert.equal(summary.overconfident, 1);
  assert.equal(summary.calibration, "Overconfident");
});

test("AIEP context and capability labels remain human-facing", () => {
  assert.equal(capabilityLabel("workspace_memory.create"), "Capture organizational memory");
  assert.equal(businessCategoryForAction({ summary: "Executive report and workspace intelligence refresh" }), "Executive visibility");
  const labels = contextContributionLabels({
    action: { evidence: [{ text: "attendance, goals, dependency graph and manager preference were used" }] },
    runtimeRun: {},
    invocations: [],
  }).map((item) => item.label);

  assert.ok(labels.includes("Attendance"));
  assert.ok(labels.includes("Goals"));
  assert.ok(labels.includes("Dependency graph"));
  assert.ok(labels.includes("Manager preferences"));
});
