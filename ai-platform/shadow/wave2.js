// ai-platform/shadow/wave2.js
//
// Epic B — remainder (all remaining backend generateText-based capabilities).
// Same shadow-first method as Wave 1: the v2 path is validated against legacy via
// the P0 harness; NO production call site is cut over (production untouched).
// Reuses buildV2Request from wave1.js (the mapping is generic). Pure module.

export const WAVE2_CAPABILITIES = Object.freeze([
  "meeting_intelligence",
  "huddle_topic_segmentation",
  "huddle_risk_blocker_extraction",
  "huddle_language_normalization",
  "huddle_copilot",
  "workspace_assistant",
  "ai_features",
  "nl_task_creation",
  "autopilot_standup",
  "browser_agent",
  "testing_agent",
  "smart_browser_test",
]);

// All remaining backend capabilities route through services/llm.js#generateText
// (some via a `generate = generateText` injection seam, e.g. the huddle pipeline).
export const WAVE2_LEGACY_TRANSPORT = Object.freeze(
  Object.fromEntries(WAVE2_CAPABILITIES.map((k) => [k, "generateText"]))
);
