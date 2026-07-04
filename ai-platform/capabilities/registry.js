// ai-platform/capabilities/registry.js
//
// The code-side source of truth for AI capabilities. Every AI capability MUST
// be registered here (principle: "no hidden AI"). These defaults are intentionally
// null for provider/model/profile/prompt so that, until Superadmin configures a
// capability in AI Studio, resolution falls through to the platform/env default
// and behavior is identical to today.
//
// The DB (ai_capabilities) can override any of these at runtime; this registry
// guarantees a capability always resolves even before any migration/seed runs.

const CAPABILITIES = new Map();

export function registerCapability(def) {
  if (!def?.key) throw new Error("Capability requires a key");
  CAPABILITIES.set(def.key, {
    key: def.key,
    name: def.name || def.key,
    description: def.description || "",
    category: def.category || "general",
    owner: def.owner || "platform",
    // null => inherit platform/env default (no behavior change)
    defaultProvider: def.defaultProvider ?? null,
    defaultModel: def.defaultModel ?? null,
    defaultProfile: def.defaultProfile ?? null,
    defaultPromptKey: def.defaultPromptKey ?? null,
    // Optional code fallback prompt builder — used only if no DB/workspace prompt.
    fallbackPrompt: typeof def.fallbackPrompt === "function" ? def.fallbackPrompt : null,
    enabled: def.enabled !== false,
  });
  return CAPABILITIES.get(def.key);
}

export function getCapability(key) {
  return CAPABILITIES.get(key) || null;
}

export function listCapabilities() {
  return [...CAPABILITIES.values()];
}

// A permissive capability used for legacy generateText() calls that do not yet
// declare a capability id. Keeps behavior identical to pre-platform.
export const LEGACY_CAPABILITY_KEY = "legacy.generate_text";

// ── Seed the known AI surface discovered during Phases 1–2 ───────────────────
// Categories mirror the AI Studio grouping. Defaults null => inherit env.
[
  { key: LEGACY_CAPABILITY_KEY, name: "Legacy generateText", category: "core", description: "Backward-compatible path for callers that have not adopted a capability id." },
  { key: "meeting_intelligence", name: "Meeting Intelligence", category: "meetings", description: "Transcript → topics → risk/blockers → decisions/action items → executive synthesis." },
  { key: "huddle_copilot", name: "Huddle Copilot", category: "meetings", description: "In-call assistant over huddle context." },
  { key: "huddle_topic_segmentation", name: "Huddle Topic Segmentation", category: "meetings" },
  { key: "huddle_risk_blocker_extraction", name: "Huddle Risk/Blocker Extraction", category: "meetings" },
  { key: "huddle_language_normalization", name: "Huddle Language Normalization", category: "meetings" },
  { key: "workspace_assistant", name: "Workspace AI Assistant", category: "assistant", description: "RAG Q&A over workspace data (ai.intelligence.service)." },
  { key: "executive_summary", name: "Executive Summary", category: "intelligence" },
  { key: "dashboard_summary", name: "Executive Dashboard Summary", category: "intelligence" },
  { key: "forecast_reasoning", name: "Forecast Reasoning", category: "intelligence" },
  { key: "risk_analysis", name: "Risk Analysis", category: "intelligence" },
  { key: "llm_explanation", name: "LLM Explanation", category: "intelligence" },
  { key: "task_suggestions", name: "Task Suggestions", category: "work" },
  { key: "nl_task_creation", name: "Natural-Language Task Creation", category: "work" },
  { key: "autopilot_standup", name: "Autopilot Standup", category: "automation" },
  { key: "ai_features", name: "AI Features", category: "assistant" },
  { key: "testing_agent", name: "Testing Agent", category: "developer" },
  { key: "smart_browser_test", name: "Smart Browser Test", category: "developer" },
  { key: "chat_away_responder", name: "Chat Away-Colleague Responder", category: "assistant", description: "Standalone ai-service responder (to be routed through the gateway in a later phase)." },
].forEach(registerCapability);
