// ai-platform/studio/configStore.service.js
//
// Epic C — Studio configuration mutations (providers, models, runtime profiles,
// capability config, locks). DB-backed, schema-tolerant, audited. This is what
// makes "no admin edits DB rows by hand" true. UNVERIFIED AT RUNTIME.

import { q } from "./db.js";
import { recordAudit } from "./audit.service.js";
import { negotiate } from "../providers/negotiation.js";
import { getCapability } from "../capabilities/registry.js";
import { LOCK_LEVELS } from "../governance/locks.js";

export async function upsertProvider({ key, displayName, adapter, baseUrl = null, apiKeyEnv = null, defaultModel = null, enabled = true, lockLevel = "workspace_customizable", actorId = null }) {
  await q(
    `INSERT INTO ai_providers (key, display_name, adapter, base_url, api_key_env, default_model, enabled, lock_level)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (key) DO UPDATE SET display_name=EXCLUDED.display_name, adapter=EXCLUDED.adapter,
       base_url=EXCLUDED.base_url, api_key_env=EXCLUDED.api_key_env, default_model=EXCLUDED.default_model,
       enabled=EXCLUDED.enabled, lock_level=EXCLUDED.lock_level, updated_at=now()`,
    [key, displayName, adapter, baseUrl, apiKeyEnv, defaultModel, enabled, lockLevel]
  );
  await recordAudit({ actorType: "superadmin", actorId, action: "upsert", objectType: "provider", objectKey: key });
  return { ok: true };
}

export async function upsertModel({ providerKey, modelKey, displayName = null, contextWindow = null, inputCostPer1k = null, outputCostPer1k = null, enabled = true, lockLevel = "workspace_customizable", actorId = null }) {
  await q(
    `INSERT INTO ai_models (provider_key, model_key, display_name, context_window, input_cost_per_1k, output_cost_per_1k, enabled, lock_level)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (provider_key, model_key) DO UPDATE SET display_name=EXCLUDED.display_name,
       context_window=EXCLUDED.context_window, input_cost_per_1k=EXCLUDED.input_cost_per_1k,
       output_cost_per_1k=EXCLUDED.output_cost_per_1k, enabled=EXCLUDED.enabled, lock_level=EXCLUDED.lock_level`,
    [providerKey, modelKey, displayName, contextWindow, inputCostPer1k, outputCostPer1k, enabled, lockLevel]
  );
  await recordAudit({ actorType: "superadmin", actorId, action: "upsert", objectType: "model", objectKey: `${providerKey}/${modelKey}` });
  return { ok: true };
}

export async function upsertRuntimeProfile({ key, displayName, params = {}, lockLevel = "workspace_customizable", actorId = null }) {
  await q(
    `INSERT INTO ai_runtime_profiles (key, display_name, params_json, is_system, lock_level)
     VALUES ($1,$2,$3,false,$4)
     ON CONFLICT (key) DO UPDATE SET display_name=EXCLUDED.display_name, params_json=EXCLUDED.params_json, lock_level=EXCLUDED.lock_level`,
    [key, displayName, JSON.stringify(params), lockLevel]
  );
  await recordAudit({ actorType: "superadmin", actorId, action: "upsert", objectType: "profile", objectKey: key });
  return { ok: true };
}

/** Validate + persist a capability configuration (platform default or workspace override). */
export async function upsertCapabilityConfig({ capabilityKey, scope = "PLATFORM", workspaceId = null, provider = null, model = null, promptKey = null, runtimeProfile = null, enabled = true, lockLevel = "workspace_customizable", actorId = null }) {
  // Validate the chosen provider/model against the capability's requirements.
  const cap = getCapability(capabilityKey);
  if (!cap) return { ok: false, reason: "unknown_capability" };
  if (provider) {
    const neg = negotiate(provider, model, cap.requires);
    if (!neg.ok) return { ok: false, reason: "incompatible_provider", gaps: neg.gaps };
  }
  await q(
    `INSERT INTO ai_capability_config (capability_key, scope, workspace_id, enabled, provider, model, prompt_key, runtime_profile, lock_level, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (capability_key, scope, workspace_id) DO UPDATE SET enabled=EXCLUDED.enabled,
       provider=EXCLUDED.provider, model=EXCLUDED.model, prompt_key=EXCLUDED.prompt_key,
       runtime_profile=EXCLUDED.runtime_profile, lock_level=EXCLUDED.lock_level, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [capabilityKey, scope, workspaceId, enabled, provider, model, promptKey, runtimeProfile, lockLevel, actorId]
  );
  await recordAudit({ actorType: scope === "PLATFORM" ? "superadmin" : "workspace_admin", actorId, action: "upsert", objectType: "capability_config", objectKey: capabilityKey, workspaceId, after: { provider, model, promptKey, runtimeProfile } });
  return { ok: true };
}

/** Set the lock level on a capability config object. */
export async function setLock({ capabilityKey, scope = "PLATFORM", workspaceId = null, lockLevel, actorId = null }) {
  if (!LOCK_LEVELS.includes(lockLevel)) return { ok: false, reason: "invalid_lock_level" };
  await q(
    `UPDATE ai_capability_config SET lock_level = $4, updated_by = $5, updated_at = now()
      WHERE capability_key = $1 AND scope = $2 AND (workspace_id = $3 OR ($3 IS NULL AND workspace_id IS NULL))`,
    [capabilityKey, scope, workspaceId, lockLevel, actorId]
  );
  await recordAudit({ actorType: "superadmin", actorId, action: "lock", objectType: "capability_config", objectKey: capabilityKey, workspaceId, after: { lockLevel } });
  return { ok: true, lockLevel };
}
