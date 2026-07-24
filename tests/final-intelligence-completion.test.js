import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCoachInsights,
  buildUniversalExplanation,
  discoverMemoryPatternsFromEvidence,
  evaluateExperimentVariants,
} from "../adaptive/evaluation/finalIntelligenceCompletion.service.js";

function evaluation({
  category = "Delivery risk management",
  effectiveness = 0.72,
  response = "executed",
  context = ["Meetings"],
  capability = ["Notify the right people"],
} = {}) {
  return {
    recommendation_category: category,
    effectiveness_score: effectiveness,
    lifecycle: { stages: [{ label: "User response", value: response }] },
    context_summary: context.map((label) => ({ label })),
    capability_summary: capability.map((label) => ({ label })),
    confidence_calibration: { evaluated: 1, falsePositives: 0, falseNegatives: 0, overconfident: 0, underconfident: 0 },
    business_outcomes: { dimensions: [{ label: "Delivery", score: effectiveness }] },
    learning_summary: { learningChanges: ["Prediction accuracy update"], explanation: "Learning changed future calibration." },
    explainability: {
      whyRecommended: "Delivery risk was detected from measured evidence.",
      outcome: "The recommendation improved measured delivery outcomes.",
      wouldRecommendAgain: effectiveness >= 0.55,
      predictedConfidence: effectiveness,
    },
  };
}

test("Adaptive Intelligence Coach produces evidence-based guidance instead of generic advice", () => {
  const currentRecords = [
    evaluation({ effectiveness: 0.82 }),
    evaluation({ effectiveness: 0.78 }),
    evaluation({ effectiveness: 0.74 }),
    evaluation({ category: "Meeting follow-through", effectiveness: 0.8, context: ["Meetings"] }),
  ];
  const previousRecords = [
    evaluation({ effectiveness: 0.44, response: "rejected" }),
    evaluation({ effectiveness: 0.48, response: "rejected" }),
    evaluation({ effectiveness: 0.46, response: "pending" }),
  ];
  const insights = buildCoachInsights({ currentRecords, previousRecords });

  assert.ok(insights.length >= 1);
  assert.ok(insights.every((insight) => Array.isArray(insight.evidence) && insight.evidence.length > 0));
  assert.ok(insights.some((insight) => /acceptance|effectiveness|outcomes/i.test(`${insight.title} ${insight.summary}`)));
  assert.ok(insights.every((insight) => insight.expectedBusinessImpact));
});

test("Adaptive Experiments only recommend winners after meaningful evidence exists", () => {
  const experiment = {
    variants: [
      { key: "a", label: "Meeting follow-up", filter: { recommendationCategory: "Meeting follow-through" } },
      { key: "b", label: "Reminder notification", filter: { recommendationCategory: "Communication and nudges" } },
    ],
    primary_metric: "effectiveness",
    minimum_sample_size: 3,
    meaningful_delta: 0.08,
  };
  const weakEvidence = evaluateExperimentVariants({
    experiment,
    records: [
      evaluation({ category: "Meeting follow-through", effectiveness: 0.8 }),
      evaluation({ category: "Communication and nudges", effectiveness: 0.65 }),
    ],
  });
  assert.equal(weakEvidence.recommendation.meaningfulEvidence, false);
  assert.equal(weakEvidence.recommendation.winner, null);

  const meaningful = evaluateExperimentVariants({
    experiment,
    records: [
      evaluation({ category: "Meeting follow-through", effectiveness: 0.82 }),
      evaluation({ category: "Meeting follow-through", effectiveness: 0.8 }),
      evaluation({ category: "Meeting follow-through", effectiveness: 0.79 }),
      evaluation({ category: "Communication and nudges", effectiveness: 0.55 }),
      evaluation({ category: "Communication and nudges", effectiveness: 0.58 }),
      evaluation({ category: "Communication and nudges", effectiveness: 0.54 }),
    ],
  });
  assert.equal(meaningful.recommendation.meaningfulEvidence, true);
  assert.equal(meaningful.recommendation.winner.label, "Meeting follow-up");
});

test("Adaptive Memory discovers behavioural patterns from outcomes and feedback", () => {
  const patterns = discoverMemoryPatternsFromEvidence({
    evaluations: [
      evaluation({ category: "Delivery risk management", effectiveness: 0.32, response: "rejected" }),
      evaluation({ category: "Delivery risk management", effectiveness: 0.36, response: "rejected" }),
      evaluation({ category: "Delivery risk management", effectiveness: 0.4, response: "rejected" }),
      evaluation({ category: "Meeting follow-through", effectiveness: 0.82, response: "executed" }),
      evaluation({ category: "Meeting follow-through", effectiveness: 0.79, response: "accepted" }),
      evaluation({ category: "Meeting follow-through", effectiveness: 0.75, response: "executed" }),
    ],
    learningSignals: [
      { signal_key: "recommendation.rejected", action_type: "notify_user", summary: "meeting recommendation", created_at: "2026-07-02T18:00:00Z", action_created_at: "2026-07-02T18:00:00Z", actor_role: "manager" },
      { signal_key: "recommendation.ignored", action_type: "notify_user", summary: "meeting recommendation", created_at: "2026-07-02T19:00:00Z", action_created_at: "2026-07-02T19:00:00Z", actor_role: "manager" },
      { signal_key: "recommendation.rejected", action_type: "notify_user", summary: "meeting recommendation", created_at: "2026-07-02T20:00:00Z", action_created_at: "2026-07-02T20:00:00Z", actor_role: "manager" },
    ],
  });

  assert.ok(patterns.some((pattern) => pattern.direction === "avoid"));
  assert.ok(patterns.some((pattern) => pattern.direction === "prefer"));
  assert.ok(patterns.every((pattern) => pattern.evidence.length > 0));
});

test("Universal Explainability answers required business questions and hides internal keys", () => {
  const explanationJson = buildUniversalExplanation({
    action: {
      summary: "Review delivery blocker",
      explanation: "notification.send was selected after recommendation.accepted history.",
      capability_key: "notification.send",
      confidence: 0.81,
    },
    evaluation: evaluation({ category: "Delivery risk management", effectiveness: 0.81 }),
    memoryPatterns: [{ pattern_summary: "Managers prefer meeting follow-up when delivery risk is high.", confidence: 0.72, recommended_use: "Prefer meeting follow-up." }],
    similarEvaluations: [evaluation({ category: "Delivery risk management", effectiveness: 0.79 })],
  });
  const explanation = JSON.parse(explanationJson);

  assert.ok(explanation.whyRecommended);
  assert.ok(explanation.contextInfluences.length > 0);
  assert.ok(explanation.historicalBehaviour.length > 0);
  assert.ok(explanation.learningSignals.length > 0);
  assert.ok(explanation.expectedBusinessOutcome);
  assert.ok(explanation.similarHistoricalSituations.length > 0);
  assert.ok(explanation.previousFeedbackChanges);
  assert.ok(explanation.wouldRecommendationChangeToday);
  assert.equal(explanationJson.includes("notification.send"), false);
  assert.equal(explanationJson.includes("recommendation.accepted"), false);
});
