// config/platformFeatures.js
//
// DB-backed, per-workspace enablement for the Execution Platform + Enterprise
// Intelligence — toggled by a superadmin from the UI (enterprise-grade, not env-only).
// A tiny in-memory cache keeps the sync feature-gates fast; it refreshes on a timer and
// immediately after a toggle. Schema-tolerant: with no table/DB it is simply "all off",
// so the env flags remain the only source — zero behavior change until used.

import { q } from "../ai-platform/studio/db.js";

const cache = { data: {}, ts: 0 }; // feature -> Set(workspaceId)
const REFRESH_MS = 20_000;

async function refresh() {
  try {
    const { rows } = await q(`SELECT workspace_id, feature FROM platform_workspace_features WHERE enabled = true`);
    const map = {};
    for (const r of rows) { (map[r.feature] ||= new Set()).add(String(r.workspace_id)); }
    cache.data = map; cache.ts = Date.now();
  } catch { /* keep previous cache (schema-tolerant) */ }
}

/** Start the background refresh (call once at boot). Safe/no-op without a DB. */
export function primePlatformFeatures() {
  refresh();
  const t = setInterval(refresh, REFRESH_MS);
  if (typeof t.unref === "function") t.unref();
}

/** Fast, sync check used by the feature-gates. */
export function isFeatureEnabledCached(feature, workspaceId) {
  return Boolean(workspaceId && cache.data[feature]?.has(String(workspaceId)));
}

/** All workspaces a feature is enabled for (used by the orchestrator worker). */
export function enabledWorkspacesFor(feature) {
  return [...(cache.data[feature] || [])];
}

/** Authoritative live read (for the settings UI). */
export async function getWorkspaceFeatures(workspaceId) {
  try {
    const { rows } = await q(`SELECT feature, enabled FROM platform_workspace_features WHERE workspace_id = $1`, [workspaceId]);
    return Object.fromEntries(rows.map((r) => [r.feature, Boolean(r.enabled)]));
  } catch { return {}; }
}

/** Toggle a feature for a workspace, then refresh the cache. */
export async function setFeatureEnabled({ feature, workspaceId, enabled, actorId = null }) {
  if (!feature || !workspaceId) return { ok: false, reason: "missing_args" };
  await q(
    `INSERT INTO platform_workspace_features (workspace_id, feature, enabled, updated_by, updated_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (workspace_id, feature) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [workspaceId, feature, Boolean(enabled), actorId]
  );
  await refresh();
  return { ok: true, feature, workspaceId, enabled: Boolean(enabled) };
}
