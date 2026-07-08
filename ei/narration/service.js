// ei/narration/service.js
//
// EI V2.1 Phase 8 — orchestration: narrate a batch of EI records into business
// language. Deterministic, flag-gated, additive. Narration is presentation only, so
// nothing is persisted. The optional LLM path is doubly gated (EI_NARRATION_LLM_ENABLED
// AND an injected Contract-V2 invoke fn); with the flag off or no injector, every item
// is narrated by the deterministic templates.

import { narrate } from "./narrator.js";
import { isEiNarrationEnabled, isEiNarrationLlmEnabled } from "../config/flags.js";

/**
 * @param {object} args
 * @param {string} args.workspaceId
 * @param {Array}  args.items   [{ kind, record, context? }]
 * @param {object} [deps] { llm } — optional Contract-V2 invoke fn
 */
export async function narrateForWorkspace({ workspaceId, items = [] } = {}, deps = {}) {
  if (!isEiNarrationEnabled(workspaceId)) return { skipped: "flag_off" };
  const useLlm = isEiNarrationLlmEnabled(workspaceId) && typeof deps.llm === "function";
  const llmDeps = useLlm ? { llm: deps.llm } : {};

  const narrated = [];
  for (const item of items) {
    narrated.push(await narrate({ kind: item.kind, record: item.record, context: item.context }, llmDeps));
  }
  return {
    workspaceId: String(workspaceId),
    eiVersion: "2.1",
    mode: useLlm ? "llm_with_template_fallback" : "deterministic",
    narrated,
  };
}
