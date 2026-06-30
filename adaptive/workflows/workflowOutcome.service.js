import pool from "../../db.js";

export async function completeWorkflowApprovalOutcome({ workspaceId, actionId, executed }) {
  const status = executed ? "completed" : "approval_pending";
  const { rows } = await pool.query(
    `
    UPDATE adaptive_workflow_runs
    SET status = $1,
        state = jsonb_set(COALESCE(state, '{}'::jsonb), '{approvalOutcome}', $2::jsonb, true),
        completed_at = CASE WHEN $1 = 'completed' THEN NOW() ELSE completed_at END
    WHERE workspace_id = $3
      AND status = 'approval_pending'
      AND state->>'approvalActionId' = $4
    RETURNING id
    `,
    [status, JSON.stringify({ actionId, executed, recordedAt: new Date().toISOString() }), workspaceId, String(actionId)]
  );
  return rows;
}

export async function rejectWorkflowApprovalOutcome({ workspaceId, actionId, reason = null }) {
  const { rows } = await pool.query(
    `
    UPDATE adaptive_workflow_runs
    SET status = 'cancelled',
        state = jsonb_set(COALESCE(state, '{}'::jsonb), '{approvalOutcome}', $1::jsonb, true),
        completed_at = NOW()
    WHERE workspace_id = $2
      AND status = 'approval_pending'
      AND state->>'approvalActionId' = $3
    RETURNING id
    `,
    [JSON.stringify({ actionId, executed: false, rejected: true, reason, recordedAt: new Date().toISOString() }), workspaceId, String(actionId)]
  );
  return rows;
}
