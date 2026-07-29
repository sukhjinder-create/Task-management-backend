// ei/memory/service.js
//
// EI V2.1 Wave C — orchestration for organizational memory. Deterministic, flag-gated,
// additive. Derives candidate memory from validated records and appends it (append-only,
// versioned). Never overwrites — a new insight is a new version.

import { deriveMemories, validateMemory } from "./memory.js";
import { appendMemory } from "./store.js";
import { isEiMemoryEnabled } from "../config/flags.js";

/** @param {object} args { workspaceId, predictions, outcomes, validation, effectiveness, version? } */
export async function deriveOrganizationalMemory({ workspaceId, predictions = [], outcomes = [], validation = null, effectiveness = null, version = 1 } = {}, deps = {}) {
  if (!isEiMemoryEnabled(workspaceId)) return { skipped: "flag_off" };
  const append = deps.appendMemory || appendMemory;
  const memories = deriveMemories({ workspaceId, predictions, outcomes, validation, effectiveness, version }).filter((m) => validateMemory(m).ok);
  let written = 0;
  for (const m of memories) { const id = await append(m); if (id) written += 1; }
  return { derived: memories.length, written, memories };
}
