// ai-platform/contract/index.js
//
// Contract v2 — barrel export of the foundational type/interface layer (P1).
// This module defines TYPES, ENUMS, PURE FACTORIES/VALIDATORS, and INTERFACE
// MARKERS only. It is intentionally NOT imported by any production execution
// path yet; it exists alongside the current implementation (Master Program V2, P1).

export * from "./common.js";
export * from "./version.js";
export * from "./parts.js";
export * from "./usage.js";
export * from "./errors.js";
export * from "./tracing.js";
export * from "./aiRequest.js";
export * from "./aiResponse.js";
export * from "./scheduling.js";
export * from "./runtime.js";
export * from "./provider.js";
export * from "./model.js";
export * from "./capability.js";
export * from "./prompt.js";
export * from "./cost.js";
export * from "./health.js";
export * from "./tool.js";
export * from "./memory.js";
export * from "./retrieval.js";
