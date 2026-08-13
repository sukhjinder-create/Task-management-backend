function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function getUserEvidenceStatus(user = null) {
  const analytics = user?.analytics || {};
  const attendance = user?.attendance?.metrics || {};
  const assignedWork = positiveNumber(analytics.assignedWork);
  const completedWork = positiveNumber(analytics.completedWork);
  const attendanceDays = positiveNumber(attendance.presentDays);
  const hasEvidence = assignedWork > 0 || completedWork > 0 || attendanceDays > 0;

  return {
    hasEvidence,
    status: hasEvidence ? "available" : "insufficient_evidence",
    reason: hasEvidence
      ? "task_or_attendance_evidence_available"
      : "no_task_or_attendance_evidence",
    counts: {
      assignedWork,
      completedWork,
      attendanceDays,
    },
  };
}

export function getWorkspaceEvidenceStatus(snapshot = {}) {
  const execution = snapshot.workspace?.analytics?.execution || {};
  const totalTrackedWork = positiveNumber(execution.totalWork);
  const internalWork = positiveNumber(execution.internalTotal);
  const externalWork = positiveNumber(execution.externalTotal);
  const usersWithEvidence = (snapshot.users || []).filter(
    (user) => getUserEvidenceStatus(user).hasEvidence
  ).length;
  const hasEvidence = totalTrackedWork > 0 || internalWork > 0 || externalWork > 0 || usersWithEvidence > 0;

  return {
    hasEvidence,
    status: hasEvidence ? "available" : "insufficient_evidence",
    reason: hasEvidence
      ? "workspace_execution_or_attendance_evidence_available"
      : "no_workspace_execution_or_attendance_evidence",
    counts: {
      totalTrackedWork,
      internalWork,
      externalWork,
      usersWithEvidence,
    },
  };
}

export default {
  getUserEvidenceStatus,
  getWorkspaceEvidenceStatus,
};
