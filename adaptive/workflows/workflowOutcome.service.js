import pool from "../../db.js";
import { getRuntimeSettings } from "../config/runtimeSettings.service.js";

export async function completeWorkflowApprovalOutcome({ workspaceId, actionId, executed }) {
  if (!executed) return [];
  const { rows } = await pool.query(
    `
    UPDATE adaptive_workflow_runs
    SET status = 'running',
        state = (COALESCE(state, '{}'::jsonb) - 'approvalActionId')
          || jsonb_build_object('approvalOutcome', $1::jsonb, 'lastApprovalActionId', $3::text),
        completed_at = NULL
    WHERE workspace_id = $2
      AND status = 'approval_pending'
      AND state->>'approvalActionId' = $3
    RETURNING *
    `,
    [JSON.stringify({ actionId, executed: true, recordedAt: new Date().toISOString() }), workspaceId, String(actionId)]
  );
  const { resumeApprovedWorkflowRun } = await import("./workflowEngine.service.js");
  const completed = [];
  for (const run of rows) {
    await pool.query(
      `UPDATE adaptive_workflow_step_runs
       SET status = 'succeeded',
           output_summary = COALESCE(output_summary, '{}'::jsonb)
             || jsonb_build_object('approvalOutcome', $1::jsonb),
           completed_at = NOW()
       WHERE workflow_run_id = $2
         AND workspace_id = $3
         AND step_index = GREATEST($4::int - 1, 0)
         AND status = 'approval_pending'`,
      [JSON.stringify({ actionId, executed: true }), run.id, workspaceId, run.current_step]
    );
    try {
      const continuation = await resumeApprovedWorkflowRun({ workspaceId, workflowRunId: run.id, settingsLoader: getRuntimeSettings });
      completed.push({ ...run, continuation });
    } catch (error) {
      // The workflow engine records the failed continuation on the run. The
      // approved action itself has already completed and should not be reported
      // to the user as if its side effect failed.
      completed.push({ ...run, continuation: { status: "failed", error: error?.message || String(error) } });
    }
  }
  return completed;
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
    RETURNING *
    `,
    [JSON.stringify({ actionId, executed: false, rejected: true, reason, recordedAt: new Date().toISOString() }), workspaceId, String(actionId)]
  );
  for (const run of rows) {
    await pool.query(
      `UPDATE adaptive_workflow_step_runs
       SET status = 'skipped',
           output_summary = COALESCE(output_summary, '{}'::jsonb)
             || jsonb_build_object('approvalOutcome', $1::jsonb),
           completed_at = NOW()
       WHERE workflow_run_id = $2
         AND workspace_id = $3
         AND step_index = GREATEST($4::int - 1, 0)
         AND status = 'approval_pending'`,
      [JSON.stringify({ actionId, executed: false, rejected: true, reason }), run.id, workspaceId, run.current_step]
    );
  }
  return rows;
}
