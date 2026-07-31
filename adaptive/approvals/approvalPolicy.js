export async function resolveApprovalPolicy({ recommendation, capability, settings }) {
  const configured = recommendation.approvalMode || capability.approvalMode || settings.default_approval_mode;
  if (configured === "manual_only" || capability.approvalMode === "manual_only") return "manual_only";
  if (settings.mode !== "auto") return "approval_required";
  if (!capability.autoEligible || ["high", "critical"].includes(recommendation.riskLevel)) {
    return "approval_required";
  }
  return configured === "automatic" || settings.default_approval_mode === "automatic"
    ? "automatic"
    : "approval_required";
}
