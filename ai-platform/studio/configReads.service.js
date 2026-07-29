// ai-platform/studio/configReads.service.js
//
// DB-AWARE read models. The pure readModels.js lists only the code registry; this
// merges the DB rows (providers/models/profiles configured from the UI) so that
// UI-configured items actually surface in the lists + dropdowns. A provider is
// "configured" if its env key is present OR a key was set from the UI. Secret VALUES
// are never returned — only a boolean. Schema-tolerant (empty DB → code-only).

import { q } from "./db.js";
import { listProviderViewModels, listModelViewModels, listRuntimeProfileViewModels } from "./readModels.js";

const parse = (v) => (typeof v === "string" ? (() => { try { return JSON.parse(v); } catch { return {}; } })() : (v || {}));

/** Providers = code registry ∪ DB rows; configured = env key OR UI key present. */
export async function listProvidersMerged() {
  const code = listProviderViewModels();
  let rows = [];
  try { ({ rows } = await q(`SELECT key, display_name, adapter, base_url, api_key_env, default_model, enabled, lock_level, (api_key IS NOT NULL AND length(api_key) > 0) AS has_key FROM ai_providers`)); } catch { rows = []; }
  const db = new Map(rows.map((r) => [r.key, r]));
  const out = [];
  const seen = new Set();
  for (const c of code) {
    const r = db.get(c.key); seen.add(c.key);
    out.push({ key: c.key, displayName: r?.display_name || c.displayName, adapter: r?.adapter || c.adapterProtocol, enabled: r ? r.enabled : true, configured: Boolean(c.keyOwnership?.configured) || Boolean(r?.has_key), keyEnv: c.keyOwnership?.keyRef?.ref || r?.api_key_env || null, baseUrl: r?.base_url || null, defaultModel: r?.default_model || null, lockLevel: r?.lock_level || "workspace_customizable", source: r ? "db+code" : "code" });
  }
  for (const r of rows) if (!seen.has(r.key)) out.push({ key: r.key, displayName: r.display_name, adapter: r.adapter, enabled: r.enabled, configured: Boolean(r.has_key), keyEnv: r.api_key_env || null, baseUrl: r.base_url, defaultModel: r.default_model, lockLevel: r.lock_level, source: "db" });
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** Models = code registry ∪ DB rows. */
export async function listModelsMerged() {
  const out = listModelViewModels().map((m) => ({ providerKey: m.providerKey, key: m.key, contextWindow: m.contextWindowTokens, enabled: true, source: "code" }));
  let rows = [];
  try { ({ rows } = await q(`SELECT provider_key, model_key, display_name, context_window, enabled FROM ai_models`)); } catch { rows = []; }
  const idx = new Map(out.map((m) => [`${m.providerKey}/${m.key}`, m]));
  for (const r of rows) {
    const id = `${r.provider_key}/${r.model_key}`; const ex = idx.get(id);
    if (ex) { ex.enabled = r.enabled; ex.source = "db+code"; }
    else out.push({ providerKey: r.provider_key, key: r.model_key, displayName: r.display_name, contextWindow: r.context_window, enabled: r.enabled, source: "db" });
  }
  return out.sort((a, b) => (a.providerKey + a.key).localeCompare(b.providerKey + b.key));
}

/** Runtime profiles = DB (authoritative, incl. seeded system ones) ∪ code fallback. */
export async function listProfilesMerged() {
  const byKey = new Map(listRuntimeProfileViewModels().map((p) => [p.key, { key: p.key, displayName: p.key, params: p.params, isSystem: true, source: "code" }]));
  let rows = [];
  try { ({ rows } = await q(`SELECT key, display_name, params_json, is_system FROM ai_runtime_profiles`)); } catch { rows = []; }
  for (const r of rows) byKey.set(r.key, { key: r.key, displayName: r.display_name || r.key, params: parse(r.params_json), isSystem: r.is_system, source: "db" });
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}
