// ei/experiments/store.js
//
// EI V2.1 Wave C — immutable experiment + assignment store. Append-only, idempotent
// by experiment_id / assignment_id. Schema-tolerant. UNVERIFIED AT RUNTIME.

import { q } from "../../ai-platform/studio/db.js";

export async function appendExperiment(x) {
  if (!x || !x.experimentId || !x.workspaceId) return null;
  const { rows } = await q(
    `INSERT INTO ei_experiments
       (experiment_id, workspace_id, key, version, design, arms_json, hypothesis_json,
        references_json, status, provenance_json, schema_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (experiment_id) DO NOTHING
     RETURNING experiment_id`,
    [
      x.experimentId, x.workspaceId, x.key, x.version, x.design, JSON.stringify(x.arms || []),
      JSON.stringify(x.hypothesis ?? null), JSON.stringify(x.references || {}), x.status || "defined",
      JSON.stringify(x.provenance || {}), x.schemaVersion || 1,
    ]
  );
  return rows[0]?.experiment_id ?? null;
}

export async function appendAssignment(a) {
  if (!a || !a.assignmentId || !a.experimentId) return null;
  const { rows } = await q(
    `INSERT INTO ei_experiment_assignments
       (assignment_id, experiment_id, workspace_id, subject_id, arm, bucket, assigned_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (assignment_id) DO NOTHING
     RETURNING assignment_id`,
    [a.assignmentId, a.experimentId, a.workspaceId, a.subjectId, a.arm, a.bucket]
  );
  return rows[0]?.assignment_id ?? null;
}

export async function listExperiments({ workspaceId, limit = 200 } = {}) {
  const { rows } = await q(`SELECT * FROM ei_experiments WHERE workspace_id = $1 ORDER BY experiment_id LIMIT $2`, [workspaceId, Math.min(Number(limit) || 200, 1000)]);
  return rows;
}
