// ai-platform/studio/capabilityPrompt.service.js
//
// Per-FEATURE prompt control. Surfaces the code "fallbackPrompt" (the hardcoded prompt
// each capability ships with) so a superadmin can SEE and EDIT it, and persists the
// edit as the published prompt for that capability's key — which the runtime
// promptResolver already prefers (workspace override → platform published → code
// fallback). Reuses the prompt registry; no duplicate storage.

import { q } from "./db.js";
import { getCapability } from "../capabilities/registry.js";
import { createPrompt, createVersion, transitionVersion } from "./promptRegistry.service.js";

async function publishedBody(promptKey) {
  if (!promptKey) return null;
  try {
    const { rows } = await q(
      `SELECT v.body FROM ai_prompt_versions v JOIN ai_prompts p ON p.id = v.prompt_id
        WHERE p.key = $1 AND v.status = 'published' ORDER BY v.version DESC LIMIT 1`,
      [promptKey]
    );
    return rows[0]?.body || null;
  } catch { return null; }
}

async function savedPromptKey(capabilityKey) {
  try {
    const { rows } = await q(`SELECT default_prompt_key FROM ai_capabilities WHERE key = $1`, [capabilityKey]);
    return rows[0]?.default_prompt_key || null;
  } catch { return null; }
}

/** The prompt key a feature resolves to (saved config → contract default → derived). */
export function effectivePromptKey(capabilityKey, saved, cap) {
  return saved || cap?.defaultPromptKey || `feature:${capabilityKey}`;
}

/** Variable names referenced by a {{var}} template body. Pure. */
export function extractVariables(body) {
  if (typeof body !== "string") return [];
  return [...new Set([...body.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]))];
}

/**
 * Render the code fallbackPrompt with a RECORDING proxy: every variable the function
 * reads is captured, and the rendered body shows a {{var}} marker where the context is
 * injected — so the UI displays the real template and we know which variables a custom
 * prompt must keep. Falls back to a plain render if the function needs real values.
 */
export function fallbackInfo(cap) {
  if (typeof cap?.fallbackPrompt !== "function") return { body: null, variables: [] };
  const seen = new Set();
  const proxy = new Proxy({}, {
    get: (_t, prop) => {
      if (typeof prop !== "string" || prop === "then" || prop === "toJSON") return undefined;
      seen.add(prop);
      return `{{${prop}}}`;
    },
    has: () => true,
  });
  try {
    const body = cap.fallbackPrompt(proxy);
    if (typeof body === "string") return { body, variables: [...seen] };
  } catch { /* function needs real-shaped values (arrays etc.) — fall through */ }
  try {
    const body = cap.fallbackPrompt({});
    return { body: typeof body === "string" ? body : null, variables: [...seen] };
  } catch { return { body: null, variables: [...seen] }; }
}

/**
 * Validate a custom prompt body against the variables the feature injects. Pure.
 * @returns {{ok:boolean, missing:string[]}}
 */
export function validatePromptBody({ requiredVariables = [], body = "", force = false } = {}) {
  const used = new Set(extractVariables(body));
  const missing = requiredVariables.filter((v) => !used.has(v));
  return { ok: force || missing.length === 0, missing };
}

/** What the UI shows for a feature's prompt: the hardcoded fallback + any override. */
export async function getCapabilityPrompt(capabilityKey) {
  const cap = getCapability(capabilityKey);
  if (!cap) return null;
  const saved = await savedPromptKey(capabilityKey);
  const promptKey = effectivePromptKey(capabilityKey, saved, cap);
  const published = await publishedBody(promptKey);
  const fb = fallbackInfo(cap); // { body with {{var}} markers, variables }
  return {
    capabilityKey, name: cap.name, promptKey,
    fallback: fb.body,                       // the hardcoded prompt (with {{var}} markers)
    variables: fb.variables,                 // context the feature injects — a custom prompt should keep these
    override: published,                     // the superadmin's custom prompt (if any)
    usingCustom: Boolean(published),
    hasFallback: typeof fb.body === "string",
  };
}

/** Save + publish a custom prompt for a feature (overrides the hardcoded one). */
export async function setCapabilityPrompt({ capabilityKey, body, force = false, actorId = null }) {
  const cap = getCapability(capabilityKey);
  if (!cap) return { ok: false, reason: "unknown_capability" };
  if (!body || !String(body).trim()) return { ok: false, reason: "empty_body" };
  // Guard: a custom prompt that drops the feature's context variables would silently
  // degrade the feature. Block unless explicitly forced (the UI asks for confirmation).
  const fb = fallbackInfo(cap);
  const check = validatePromptBody({ requiredVariables: fb.variables, body, force });
  if (!check.ok) return { ok: false, reason: "missing_variables", missing: check.missing };
  const saved = await savedPromptKey(capabilityKey);
  const promptKey = effectivePromptKey(capabilityKey, saved, cap);
  await createPrompt({ key: promptKey, feature: capabilityKey, category: cap.category, createdBy: actorId });
  try { await q(`UPDATE ai_prompts SET variables_json = $2, updated_by = $3, updated_at = now() WHERE key = $1`, [promptKey, JSON.stringify(extractVariables(body)), actorId]); } catch { /* schema-tolerant */ }
  const version = await createVersion({ promptKey, body, createdBy: actorId });
  await transitionVersion({ promptKey, version, to: "published", actorId });
  await q(
    `INSERT INTO ai_capabilities (key, name, category, default_prompt_key, updated_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (key) DO UPDATE SET default_prompt_key = EXCLUDED.default_prompt_key, updated_at = now()`,
    [capabilityKey, cap.name || capabilityKey, cap.category || null, promptKey]
  );
  return { ok: true, promptKey, version };
}

/** Revert a feature to its hardcoded prompt (archive the override + clear the key). */
export async function resetCapabilityPrompt({ capabilityKey, actorId = null }) {
  const saved = await savedPromptKey(capabilityKey);
  const cap = getCapability(capabilityKey);
  const promptKey = effectivePromptKey(capabilityKey, saved, cap);
  try {
    const versions = await (await import("./promptRegistry.service.js")).listVersions(promptKey);
    const pub = versions.find((v) => v.status === "published");
    if (pub) await transitionVersion({ promptKey, version: pub.version, to: "archived", actorId });
  } catch { /* best effort */ }
  await q(`UPDATE ai_capabilities SET default_prompt_key = NULL, updated_at = now() WHERE key = $1`, [capabilityKey]);
  return { ok: true };
}
