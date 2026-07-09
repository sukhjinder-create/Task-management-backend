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

export async function upsertProvider({ key, displayName, adapter, baseUrl = null, apiKeyEnv = null, defaultModel = null, enabled = true, lockLevel = "workspace_customizable", apiKey = null, actorId = null }) {
  await q(
    `INSERT INTO ai_providers (key, display_name, adapter, base_url, api_key_env, default_model, enabled, lock_level, api_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (key) DO UPDATE SET display_name=EXCLUDED.display_name, adapter=EXCLUDED.adapter,
       base_url=EXCLUDED.base_url, api_key_env=EXCLUDED.api_key_env, default_model=EXCLUDED.default_model,
       enabled=EXCLUDED.enabled, lock_level=EXCLUDED.lock_level,
       api_key=COALESCE(EXCLUDED.api_key, ai_providers.api_key), updated_at=now()`,
    [key, displayName, adapter, baseUrl, apiKeyEnv, defaultModel, enabled, lockLevel, (apiKey && String(apiKey).trim()) || null]
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

/**
 * Validate + persist a capability configuration into the SAME tables the runtime
 * resolver reads (so UI selections actually take effect):
 *   scope=PLATFORM  → ai_capabilities (default_provider/model/profile/prompt + lock)
 *   scope=workspace → ai_workspace_overrides (object_type='capability_routing')
 */
export async function upsertCapabilityConfig({ capabilityKey, scope = "PLATFORM", workspaceId = null, provider = null, model = null, promptKey = null, runtimeProfile = null, enabled = true, lockLevel = "workspace_customizable", actorId = null }) {
  const cap = getCapability(capabilityKey);
  if (!cap) return { ok: false, reason: "unknown_capability" };
  if (provider) {
    const neg = negotiate(provider, model, cap.requires);
    if (!neg.ok) return { ok: false, reason: "incompatible_provider", gaps: neg.gaps };
  }
  if (scope === "PLATFORM") {
    await q(
      `INSERT INTO ai_capabilities (key, name, category, default_provider_key, default_model_key, default_profile_key, default_prompt_key, enabled, lock_level, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       ON CONFLICT (key) DO UPDATE SET default_provider_key=EXCLUDED.default_provider_key,
         default_model_key=EXCLUDED.default_model_key, default_profile_key=EXCLUDED.default_profile_key,
         default_prompt_key=EXCLUDED.default_prompt_key, lock_level=EXCLUDED.lock_level, enabled=EXCLUDED.enabled, updated_at=now()`,
      [capabilityKey, cap.name || capabilityKey, cap.category || null, provider, model, runtimeProfile, promptKey, enabled, lockLevel]
    );
  } else {
    await q(
      `INSERT INTO ai_workspace_overrides (workspace_id, object_type, object_key, value_json, lock_level, updated_by, updated_at)
       VALUES ($1, 'capability_routing', $2, $3, $4, $5, now())
       ON CONFLICT (workspace_id, object_type, object_key) DO UPDATE SET value_json=EXCLUDED.value_json, lock_level=EXCLUDED.lock_level, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [workspaceId, capabilityKey, JSON.stringify({ provider, model, profile: runtimeProfile, prompt_key: promptKey }), lockLevel, actorId]
    );
  }
  await recordAudit({ actorType: scope === "PLATFORM" ? "superadmin" : "workspace_admin", actorId, action: "upsert", objectType: "capability_config", objectKey: capabilityKey, workspaceId, after: { provider, model, promptKey, runtimeProfile } });
  return { ok: true };
}

/** Read SAVED capability configs from the resolver's tables (platform or a workspace). */
export async function listCapabilityConfigs({ scope = "PLATFORM", workspaceId = null } = {}) {
  if (scope === "PLATFORM") {
    const { rows } = await q(
      `SELECT key, default_provider_key, default_model_key, default_prompt_key, default_profile_key, lock_level, enabled, updated_at
         FROM ai_capabilities ORDER BY key`
    );
    return rows.map((r) => ({ capabilityKey: r.key, scope: "PLATFORM", provider: r.default_provider_key, model: r.default_model_key, promptKey: r.default_prompt_key, runtimeProfile: r.default_profile_key, lockLevel: r.lock_level, enabled: r.enabled, updatedAt: r.updated_at }));
  }
  const { rows } = await q(
    `SELECT object_key, value_json, lock_level, updated_at FROM ai_workspace_overrides
      WHERE workspace_id = $1 AND object_type = 'capability_routing' ORDER BY object_key`,
    [workspaceId]
  );
  return rows.map((r) => { const v = typeof r.value_json === "string" ? JSON.parse(r.value_json) : (r.value_json || {}); return { capabilityKey: r.object_key, scope: workspaceId, provider: v.provider, model: v.model, promptKey: v.prompt_key, runtimeProfile: v.profile, lockLevel: r.lock_level, updatedAt: r.updated_at }; });
}

/** Set the lock level on a capability (platform) or a workspace's routing override. */
export async function setLock({ capabilityKey, scope = "PLATFORM", workspaceId = null, lockLevel, actorId = null }) {
  if (!LOCK_LEVELS.includes(lockLevel)) return { ok: false, reason: "invalid_lock_level" };
  if (scope === "PLATFORM") {
    await q(`UPDATE ai_capabilities SET lock_level=$2, updated_at=now() WHERE key=$1`, [capabilityKey, lockLevel]);
  } else {
    await q(
      `INSERT INTO ai_workspace_overrides (workspace_id, object_type, object_key, value_json, lock_level, updated_by, updated_at)
       VALUES ($1,'capability_routing',$2,'{}'::jsonb,$3,$4, now())
       ON CONFLICT (workspace_id, object_type, object_key) DO UPDATE SET lock_level=EXCLUDED.lock_level, updated_at=now()`,
      [workspaceId, capabilityKey, lockLevel, actorId]
    );
  }
  await recordAudit({ actorType: "superadmin", actorId, action: "lock", objectType: "capability_config", objectKey: capabilityKey, workspaceId, after: { lockLevel } });
  return { ok: true, lockLevel };
}
