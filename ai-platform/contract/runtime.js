// ai-platform/contract/runtime.js
//
// Contract v2 §8 — Runtime contract. Six INDEPENDENT axes: one sampling profile
// plus five orthogonal policy types. Type definitions + enums only. No sampling
// resolution here (that lives in ai-platform/runtime/*, a separate, already
// existing concern) — this file only fixes the permanent shapes.

export const POLICY_KINDS = Object.freeze([
  "execution", "reasoning", "performance", "cost", "safety",
]);

/**
 * @typedef {object} SamplingParams
 * @property {number} [temperature]
 * @property {number} [topP]
 * @property {number} [topK]
 * @property {number} [maxTokens]
 * @property {boolean} [json]
 *
 * @typedef {object} RuntimeProfile
 * @property {string} key
 * @property {SamplingParams} params
 *
 * @typedef {object} ExecutionPolicy
 * @property {("sync"|"async"|"stream"|"batch")} mode
 * @property {number} timeoutMs
 * @property {number} [maxSteps]
 * @property {number} [concurrency]
 *
 * @typedef {object} ReasoningPolicy
 * @property {("none"|"low"|"medium"|"high")} effort
 * @property {("terse"|"normal"|"detailed")} [verbosity]
 * @property {number} [toolBudget]
 * @property {number} [maxToolLoops]
 *
 * @typedef {object} PerformancePolicy
 * @property {number} [latencySloMs]
 * @property {("off"|"model"|"provider"|"both")} failover
 * @property {number} [cacheTtlSeconds]
 *
 * @typedef {object} CostPolicy
 * @property {import("./common.js").Money} [maxCostPerCall]
 * @property {("trivial"|"low"|"medium"|"high")} [modelTierCeiling]
 * @property {string} [budgetRef]
 *
 * @typedef {object} SafetyPolicy
 * @property {("off"|"standard"|"strict")} injectionDefense
 * @property {("off"|"tag"|"redact"|"block")} piiRedaction
 * @property {object} contentFilters
 * @property {string[]} [toolAllowlist]
 *
 * @typedef {object} PolicySet
 * @property {string} key
 * @property {ExecutionPolicy} execution
 * @property {ReasoningPolicy} [reasoning]
 * @property {PerformancePolicy} [performance]
 * @property {CostPolicy} [cost]
 * @property {SafetyPolicy} safety
 *
 * @typedef {object} RuntimeDirective
 * @property {string} [profile]
 * @property {object} [policySet]
 * @property {object} [overrides]
 */

export {};
