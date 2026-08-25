-- Fixes: deleting a user OR a workspace failed with
--   new row for relation "operations_ai_actions" violates check constraint
--   "operations_ai_actions_approval_execution_check"
--
-- operations_ai_actions.approved_by is ON DELETE SET NULL, matching how every
-- other attribution column in this schema treats a deleted user: the record
-- survives, the identity is forgotten. But the approval check added in
-- 20260630_adaptive_enterprise_orchestrator.sql also required approved_by to
-- stay NOT NULL on any executed, approval-required action -- so the SET NULL
-- that fires when the approver is deleted immediately violated the check, and
-- the whole delete aborted.
--
-- The constraint exists to stop the adaptive runtime executing an
-- approval-required action that was never approved. approved_by and
-- approved_at are always written together in the same UPDATE
-- (services/operationsAction.service.js), so approved_at alone already proves
-- the approval happened -- and unlike approved_by it is a timestamp that no
-- cascade nulls. Dropping only the approved_by clause therefore preserves the
-- execution invariant exactly while letting the approver's identity be
-- forgotten, which is what ON DELETE SET NULL was always meant to do.

ALTER TABLE IF EXISTS public.operations_ai_actions
  DROP CONSTRAINT IF EXISTS operations_ai_actions_approval_execution_check;

ALTER TABLE IF EXISTS public.operations_ai_actions
  ADD CONSTRAINT operations_ai_actions_approval_execution_check
  CHECK (
    status <> 'executed'
    OR approval_mode = 'automatic'
    OR (status = 'executed' AND approved_at IS NOT NULL)
  );
