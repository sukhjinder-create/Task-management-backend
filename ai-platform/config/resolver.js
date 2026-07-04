// ai-platform/config/resolver.js
//
// Resolves the EFFECTIVE configuration for a (capability, workspace) pair by
// walking the enterprise inheritance chain and honoring the locking model:
//
//   global_locked          → platform value wins; workspace override IGNORED
//   workspace_customizable → workspace override wins if present, else platform
//   workspace_locked       → this specific workspace is pinned to a value
//
// Fallback order (when a level is absent):
//   workspace override → platform (ai_capabilities/ai_providers) → code registry → ENV
//
// CRITICAL non-regression property: with NO ai_platform_* rows present, this
// resolver returns { provider = env LLM_PROVIDER, model = null (adapter env
// default), profile = capability/balanced, prompt = null (caller prompt used
// verbatim) } — i.e., exactly the legacy behavior.

import pool from "../../db.js";
import { getCapability, LEGACY_CAPABILITY_KEY } from "../capabilities/registry.js";
import { adapterTypeForProviderKey } from "../providers/registry.js";
import { SYSTEM_PROFILES, DEFAULT_PROFILE_KEY } from "../runtime/runtimeProfiles.js";

let schemaPresent = null;

export async function hasAiPlatformSchema() {
  if (schemaPresent !== null) return schemaPresent;
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM information_schema.tables
       WHERE table_name IN ('ai_capabilities','ai_providers','ai_workspace_overrides')`
    );
    schemaPresent = (rows?.[0]?.n || 0) === 3;
  } catch {
    schemaPresent = false;
  }
  return schemaPresent;
}

/** Reset the cached schema probe (used by migration runner/tests). */
export function _resetSchemaCache() {
  schemaPresent = null;
}

function envProviderKey() {
  return String(process.env.LLM_PROVIDER || "ollama").toLowerCase();
}

async function loadCapabilityRow(key) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM ai_capabilities WHERE key = $1 LIMIT 1`,
      [key]
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}

async function loadWorkspaceRouting(workspaceId, capabilityKey) {
  if (!workspaceId) return null;
  try {
    const { rows } = await pool.query(
      `SELECT value_json, lock_level FROM ai_workspace_overrides
       WHERE workspace_id = $1 AND object_type = 'capability_routing' AND object_key = $2 LIMIT 1`,
      [workspaceId, capabilityKey]
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}

async function loadProviderRow(providerKey) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM ai_providers WHERE key = $1 AND enabled = true LIMIT 1`,
      [providerKey]
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}

async function loadProfileRow(profileKey) {
  try {
    const { rows } = await pool.query(
      `SELECT params_json FROM ai_runtime_profiles WHERE key = $1 LIMIT 1`,
      [profileKey]
    );
    return rows[0]?.params_json || null;
  } catch {
    return null;
  }
}

/**
 * Enterprise-inheritance pick for a single field.
 * @param {string} lockLevel   platform object's lock level
 * @param {*} platformValue
 * @param {*} workspaceValue
 */
function pickWithLock(lockLevel, platformValue, workspaceValue) {
  if (lockLevel === "global_locked") return platformValue; // workspace cannot override
  if (workspaceValue != null) return workspaceValue;       // customizable / workspace_locked
  return platformValue;
}

function synthProviderConfig(providerKey, providerRow) {
  const adapterType =
    (providerRow?.adapter && String(providerRow.adapter)) || adapterTypeForProviderKey(providerKey);
  return {
    key: providerKey,
    adapter: adapterType,
    baseUrl: providerRow?.base_url || null,
    apiKeyEnv: providerRow?.api_key_env || null,
    defaultModel: providerRow?.default_model || null,
    timeoutMs: providerRow?.timeout_ms || null,
    extra: providerRow?.config_json || null,
    lockLevel: providerRow?.lock_level || "workspace_customizable",
  };
}

/**
 * @returns {Promise<{
 *   capabilityKey, providerKey, adapterType, providerConfig, model,
 *   profileKey, profileParams, promptKey, locks
 * }>}
 */
export async function resolveEffectiveConfig({ capabilityKey, workspaceId }) {
  const key = capabilityKey || LEGACY_CAPABILITY_KEY;
  const reg = getCapability(key) || getCapability(LEGACY_CAPABILITY_KEY);

  // Env/registry-only fast path (pre-migration or schema absent) — legacy behavior.
  if (!(await hasAiPlatformSchema())) {
    const providerKey = reg?.defaultProvider || envProviderKey();
    return {
      capabilityKey: key,
      providerKey,
      adapterType: adapterTypeForProviderKey(providerKey),
      providerConfig: synthProviderConfig(providerKey, null),
      model: reg?.defaultModel || null,
      profileKey: reg?.defaultProfile || DEFAULT_PROFILE_KEY,
      profileParams: null,
      promptKey: reg?.defaultPromptKey || null,
      locks: { source: "registry+env" },
    };
  }

  const capRow = await loadCapabilityRow(key);
  const routing = await loadWorkspaceRouting(workspaceId, key);
  const wsVal = routing?.value_json || {};
  const capLock = capRow?.lock_level || "workspace_customizable";

  const providerKey = pickWithLock(
    capLock,
    capRow?.default_provider_key || reg?.defaultProvider || envProviderKey(),
    wsVal.provider
  );
  const model = pickWithLock(
    capLock,
    capRow?.default_model_key || reg?.defaultModel || null,
    wsVal.model
  );
  const profileKey = pickWithLock(
    capLock,
    capRow?.default_profile_key || reg?.defaultProfile || DEFAULT_PROFILE_KEY,
    wsVal.profile
  );
  const promptKey = pickWithLock(
    capLock,
    capRow?.default_prompt_key || reg?.defaultPromptKey || null,
    wsVal.prompt_key
  );

  const providerRow = await loadProviderRow(providerKey);
  const profileParams = SYSTEM_PROFILES[profileKey] ? null : await loadProfileRow(profileKey);

  return {
    capabilityKey: key,
    providerKey,
    adapterType: (providerRow?.adapter && String(providerRow.adapter)) || adapterTypeForProviderKey(providerKey),
    providerConfig: synthProviderConfig(providerKey, providerRow),
    model,
    profileKey,
    profileParams,
    promptKey,
    locks: { capability: capLock, provider: providerRow?.lock_level || null },
  };
}
