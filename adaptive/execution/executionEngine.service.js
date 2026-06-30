import pool from "../../db.js";
import { logAudit } from "../../services/audit.service.js";
import { capabilityEnabled } from "../config/runtimeSettings.service.js";
import { getCapability } from "../capabilities/capabilityRegistry.js";
import { compactSummary } from "../shared/runtimeUtils.js";

async function loadIdempotentInvocation(workspaceId, idempotencyKey) {
  if (!idempotencyKey) return null;
  const { rows } = await pool.query(
    `SELECT * FROM adaptive_capability_invocations
     WHERE workspace_id = $1 AND idempotency_key = $2 LIMIT 1`,
    [workspaceId, idempotencyKey]
  );
  return rows[0] || null;
}

export async function recordProposedInvocation({
  workspaceId,
  runtimeRunId,
  capability,
  approvalMode,
  idempotencyKey,
  input,
  actorUserId,
}) {
  const { rows } = await pool.query(
    `
    INSERT INTO adaptive_capability_invocations (
      workspace_id, runtime_run_id, capability_key, capability_version,
      status, approval_mode, idempotency_key, input_summary, actor_user_id, completed_at
    ) VALUES ($1,$2,$3,$4,'proposed',$5,$6,$7::jsonb,$8,NOW())
    ON CONFLICT (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL
    DO UPDATE SET runtime_run_id = COALESCE(adaptive_capability_invocations.runtime_run_id, EXCLUDED.runtime_run_id)
    RETURNING *
    `,
    [
      workspaceId,
      runtimeRunId || null,
      capability.key,
      capability.version,
      approvalMode,
      idempotencyKey || null,
      JSON.stringify(compactSummary(input)),
      actorUserId || null,
    ]
  );
  return rows[0];
}

export async function executeCapability({
  workspaceId,
  runtimeRunId = null,
  capabilityKey,
  input = {},
  actor = {},
  settings,
  approvalMode = null,
  idempotencyKey = null,
}) {
  const capability = getCapability(capabilityKey);
  if (!capability) throw new Error(`Unknown capability: ${capabilityKey}`);
  if (!capabilityEnabled(settings, capabilityKey)) throw new Error(`Capability disabled: ${capabilityKey}`);
  if (!capability.allowedRoles.includes(actor?.role || "user")) throw new Error("Capability role denied");
  capability.validate(input);

  const existing = await loadIdempotentInvocation(workspaceId, idempotencyKey);
  if (existing?.status === "succeeded") {
    return { invocation: existing, output: existing.output_summary, idempotent: true };
  }

  const effectiveApprovalMode = approvalMode || capability.approvalMode;
  const startedAt = Date.now();
  let invocation;
  if (existing) {
    const { rows } = await pool.query(
      `UPDATE adaptive_capability_invocations
       SET status = 'started', started_at = NOW(), completed_at = NULL,
           error_code = NULL, error_message = NULL
       WHERE id = $1 RETURNING *`,
      [existing.id]
    );
    invocation = rows[0];
  } else {
    const { rows } = await pool.query(
      `
      INSERT INTO adaptive_capability_invocations (
        workspace_id, runtime_run_id, capability_key, capability_version,
        status, approval_mode, idempotency_key, input_summary, actor_user_id
      ) VALUES ($1,$2,$3,$4,'started',$5,$6,$7::jsonb,$8)
      RETURNING *
      `,
      [
        workspaceId,
        runtimeRunId,
        capability.key,
        capability.version,
        effectiveApprovalMode,
        idempotencyKey,
        JSON.stringify(compactSummary(input)),
        actor?.userId || null,
      ]
    );
    invocation = rows[0];
  }

  try {
    const output = await capability.execute({ input, workspaceId, actor, runtimeRunId });
    const durationMs = Date.now() - startedAt;
    const outputSummary = compactSummary(output);
    const { rows } = await pool.query(
      `UPDATE adaptive_capability_invocations
       SET status = 'succeeded', output_summary = $1::jsonb, duration_ms = $2,
           completed_at = NOW()
       WHERE id = $3 RETURNING *`,
      [JSON.stringify(outputSummary || {}), durationMs, invocation.id]
    );
    await logAudit({
      workspaceId,
      userId: actor?.userId || null,
      action: "adaptive.capability.execute",
      entityType: "adaptive_capability",
      entityId: invocation.id,
      metadata: { capabilityKey, runtimeRunId, durationMs },
    });
    return { invocation: rows[0], output, idempotent: false };
  } catch (error) {
    await pool.query(
      `UPDATE adaptive_capability_invocations
       SET status = 'failed', error_code = $1, error_message = $2,
           duration_ms = $3, completed_at = NOW()
       WHERE id = $4`,
      [error?.code || "CAPABILITY_EXECUTION_FAILED", String(error?.message || error).slice(0, 2000), Date.now() - startedAt, invocation.id]
    );
    throw error;
  }
}
