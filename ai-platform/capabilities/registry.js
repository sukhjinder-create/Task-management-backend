// ai-platform/capabilities/registry.js
//
// P4 — Capability registry v2. The CODE-OWNED, immutable CONTRACT for every AI
// capability (Contract v2 §4). Configuration (routing/enable/lock per scope)
// lives in the DB (ai_capabilities / ai_capability_config) — NOT here. This kills
// the split-brain gate finding: contract ≠ configuration.
//
// Backward compatible: every field the resolver/runner already read
// (defaultProvider/Model/Profile/PromptKey, fallbackPrompt, enabled, key, name,
// description, category, owner) is preserved; contract metadata is added.
//
// Reconciled with the Implementation Readiness Audit:
//  + registered enterprise_intelligence (4 generateText json calls)
//  + registered browser_agent (15 generateText calls)
//  - removed speculative dashboard_summary / task_suggestions / risk_analysis (no backing code)

import { AI_CONTRACT_VERSION } from "../contract/version.js";

const CAPABILITIES = new Map();

/** Register a capability CONTRACT. Defaults keep behavior identical until DB config exists. */
export function registerCapability(def) {
  if (!def?.key) throw new Error("Capability requires a key");
  CAPABILITIES.set(def.key, Object.freeze({
    // ── identity ──
    key: def.key,
    name: def.name || def.key,
    description: def.description || "",
    category: def.category || "general",
    owner: def.owner || "platform",
    businessOwner: def.businessOwner || def.owner || "platform",
    contractVersion: AI_CONTRACT_VERSION,
    // ── configuration defaults (null => inherit platform/env default) ──
    defaultProvider: def.defaultProvider ?? null,
    defaultModel: def.defaultModel ?? null,
    defaultProfile: def.defaultProfile ?? null,
    defaultPromptKey: def.defaultPromptKey ?? null,
    fallbackPrompt: typeof def.fallbackPrompt === "function" ? def.fallbackPrompt : null,
    enabled: def.enabled !== false,
    // ── Contract §4 metadata ──
    inputModalities: Object.freeze(def.inputModalities || ["text"]),
    outputModality: def.outputModality || "text",
    executionClass: def.executionClass || "sync",          // sync|async|streaming|batch
    requires: Object.freeze(def.requires || {}),           // ProviderRequirement
    dependsOn: Object.freeze(def.dependsOn || []),
    businessCriticality: def.businessCriticality || "standard",
    priorityClass: def.priorityClass || "normal",
    expectedLatency: def.expectedLatency || "normal",
    expectedCostClass: def.expectedCostClass || "low",
    dataSensitivity: def.dataSensitivity || "internal",
    lifecycle: def.lifecycle || "ga",
  }));
  return CAPABILITIES.get(def.key);
}

export function getCapability(key) {
  return CAPABILITIES.get(key) || null;
}

export function listCapabilities() {
  return [...CAPABILITIES.values()];
}

export const LEGACY_CAPABILITY_KEY = "legacy.generate_text";

// ── Seed: the real AI surface (reconciled with the readiness audit) ──────────
[
  { key: LEGACY_CAPABILITY_KEY, name: "Legacy generateText", category: "core",
    description: "Backward-compatible path for callers without a capability id.", requires: {} },

  // Meetings
  { key: "meeting_intelligence", name: "Meeting Intelligence", category: "meetings",
    description: "Transcript → topics → risk/blockers → decisions/action items → executive synthesis.",
    executionClass: "async", businessCriticality: "important", requires: { json: true, minContextTokens: 32000 },
    dependsOn: ["huddle_topic_segmentation", "huddle_risk_blocker_extraction", "huddle_language_normalization"] },
  { key: "huddle_copilot", name: "Huddle Copilot", category: "meetings", priorityClass: "high" },
  { key: "huddle_topic_segmentation", name: "Huddle Topic Segmentation", category: "meetings",
    executionClass: "async", requires: { json: true } },
  { key: "huddle_risk_blocker_extraction", name: "Huddle Risk/Blocker Extraction", category: "meetings",
    executionClass: "async", requires: { json: true } },
  { key: "huddle_language_normalization", name: "Huddle Language Normalization", category: "meetings",
    executionClass: "async" },

  // Assistant
  { key: "workspace_assistant", name: "Workspace AI Assistant", category: "assistant",
    description: "RAG Q&A over workspace data.", dataSensitivity: "confidential" },
  { key: "ai_features", name: "AI Features", category: "assistant" },
  { key: "chat_away_responder", name: "Chat Away-Colleague Responder", category: "assistant",
    description: "ai-task away-responder (now routed through the platform).", dataSensitivity: "confidential" },

  // ── ai-task (Epic B′) capabilities — now implementations of the platform ──
  { key: "ai_task_creation", name: "AI Task Creation", category: "work", requires: { json: true },
    description: "ai-task: create tasks from natural language.", dataSensitivity: "confidential" },
  { key: "decision_extraction", name: "Decision Extraction", category: "intelligence", requires: { json: true },
    description: "ai-task: extract decisions/authority/provenance from chat.", dataSensitivity: "confidential" },
  { key: "summarization", name: "Conversation Summarization", category: "assistant",
    description: "ai-task: summarize DM/channel activity for away users.", dataSensitivity: "confidential" },
  { key: "report_generation", name: "Report Generation", category: "intelligence",
    description: "ai-task: generate reports from workspace activity.", dataSensitivity: "confidential" },
  { key: "reasoning_summary", name: "Reasoning Summary", category: "assistant",
    description: "ai-task: safe reasoning summary attached to a reply." },

  // Intelligence
  { key: "executive_summary", name: "Executive Summary", category: "intelligence", executionClass: "async" },
  { key: "enterprise_intelligence", name: "Enterprise Intelligence", category: "intelligence",
    description: "Enterprise intelligence narratives/risk (4 json generateText calls).",
    executionClass: "async", businessCriticality: "important", requires: { json: true } },
  { key: "forecast_reasoning", name: "Forecast Reasoning", category: "intelligence",
    executionClass: "async", requires: { json: true } },
  { key: "llm_explanation", name: "LLM Explanation", category: "intelligence", executionClass: "async" },

  // Work
  { key: "nl_task_creation", name: "Natural-Language Task Creation", category: "work", requires: { json: true } },
  { key: "autopilot_standup", name: "Autopilot Standup", category: "automation", executionClass: "async" },

  // Developer / agentic
  { key: "browser_agent", name: "Browser Agent", category: "developer",
    description: "LLM-driven browser automation (15 generateText calls).", executionClass: "async" },
  { key: "testing_agent", name: "Testing Agent", category: "developer", executionClass: "async" },
  { key: "smart_browser_test", name: "Smart Browser Test", category: "developer", executionClass: "async" },
].forEach(registerCapability);
