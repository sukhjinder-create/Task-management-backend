export function assertExecutableApproval(action) {
  if (!action) throw new Error("Action not found");
  if (action.status === "executed") throw new Error("Action already executed");
  if (action.status === "rejected") throw new Error("Rejected actions cannot be executed");
  if (["approval_required", "manual_only"].includes(action.approval_mode)) {
    if (action.status !== "approved" || !action.approved_by || !action.approved_at) {
      const error = new Error("Action must be explicitly approved before execution");
      error.code = "ACTION_APPROVAL_REQUIRED";
      throw error;
    }
  }
  return true;
}
