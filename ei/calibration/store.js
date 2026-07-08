// ei/calibration/store.js
//
// EI V2.1 Wave C — immutable, versioned calibration-model store. Append-only,
// idempotent by calibration_id, never overwrites (each version is a new row). The
// current model is the highest version. Schema-tolerant. UNVERIFIED AT RUNTIME.

import { q } from "../../ai-platform/studio/db.js";

export async function appendCalibrationModel(m) {
  if (!m || !m.calibrationId || !m.workspaceId) return null;
  const { rows } = await q(
    `INSERT INTO ei_calibration_models
       (calibration_id, workspace_id, version, method, buckets_json, confidence_views_json,
        supersedes_json, provenance_json, schema_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (calibration_id) DO NOTHING
     RETURNING calibration_id`,
    [
      m.calibrationId, m.workspaceId, m.version, m.method, JSON.stringify(m.buckets || []),
      JSON.stringify(m.confidenceViews || {}), JSON.stringify(m.supersedes ?? null),
      JSON.stringify(m.provenance || {}), m.schemaVersion || 1,
    ]
  );
  return rows[0]?.calibration_id ?? null;
}

/** Current model = highest version for the workspace. */
export async function getCurrentCalibrationModel({ workspaceId } = {}) {
  const { rows } = await q(
    `SELECT * FROM ei_calibration_models WHERE workspace_id = $1 ORDER BY version DESC, calibration_id DESC LIMIT 1`,
    [workspaceId]
  );
  return rows[0] || null;
}
