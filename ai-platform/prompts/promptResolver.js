// ai-platform/prompts/promptResolver.js
//
// Prompt fallback rules (per spec, no regression):
//   workspace prompt override  →  platform published prompt  →  code fallback  →  null
//
// If the resolved template is null, the gateway uses the caller-provided prompt
// verbatim. This is what keeps every current call site (which already builds its
// own full prompt string) behaving exactly as today.

import pool from "../../db.js";
import { getCapability } from "../capabilities/registry.js";
import { hasAiPlatformSchema } from "../config/resolver.js";

function renderTemplate(body, variables = {}) {
  if (!body) return body;
  return String(body).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, name) => {
    const v = variables?.[name];
    return v == null ? "" : String(v);
  });
}

async function workspacePrompt(workspaceId, promptKey) {
  if (!workspaceId || !promptKey) return null;
  try {
    const { rows } = await pool.query(
      `SELECT value_json FROM ai_workspace_overrides
       WHERE workspace_id = $1 AND object_type = 'prompt' AND object_key = $2 LIMIT 1`,
      [workspaceId, promptKey]
    );
    return rows[0]?.value_json?.body || null;
  } catch {
    return null;
  }
}

async function platformPublishedPrompt(promptKey) {
  if (!promptKey) return null;
  try {
    const { rows } = await pool.query(
      `SELECT v.body, v.version
         FROM ai_prompt_versions v
         JOIN ai_prompts p ON p.id = v.prompt_id
        WHERE p.key = $1 AND v.status = 'published'
        ORDER BY v.version DESC
        LIMIT 1`,
      [promptKey]
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<{ body: string, promptKey: string|null, version: number|null }|null>}
 */
export async function resolvePromptTemplate({ promptKey, workspaceId, capabilityKey, variables = {} }) {
  if (await hasAiPlatformSchema()) {
    const wsBody = await workspacePrompt(workspaceId, promptKey);
    if (wsBody) return { body: renderTemplate(wsBody, variables), promptKey, version: null };

    const platform = await platformPublishedPrompt(promptKey);
    if (platform?.body) return { body: renderTemplate(platform.body, variables), promptKey, version: platform.version };
  }

  // Code fallback prompt (registry) — used pre-migration and as last resort.
  const cap = getCapability(capabilityKey);
  if (cap?.fallbackPrompt) {
    const body = cap.fallbackPrompt(variables);
    if (body) return { body: renderTemplate(body, variables), promptKey: promptKey || null, version: null };
  }

  return null; // caller prompt is used verbatim
}
