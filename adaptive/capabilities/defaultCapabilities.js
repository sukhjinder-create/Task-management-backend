import { registerCapability } from "./capabilityRegistry.js";
import { isUuid } from "../shared/runtimeUtils.js";

function requireFields(input, fields) {
  const missing = fields.filter((field) => input?.[field] == null || input?.[field] === "");
  if (missing.length) throw new Error(`Missing capability input: ${missing.join(", ")}`);
  return true;
}

export function registerDefaultCapabilities() {
  registerCapability({
    key: "notification.send",
    description: "Send an existing in-app/push notification through notification.service",
    riskLevel: "low",
    approvalMode: "approval_required",
    autoEligible: true,
    inputContract: { required: ["userId", "message"] },
    validate: (input) => requireFields(input, ["userId", "message"]),
    execute: async ({ input, workspaceId }) => {
      const { notifyUser } = await import("../../services/notification.service.js");
      return notifyUser({
        user_id: input.userId,
        type: input.type || "adaptive_recommendation",
        title: input.title || null,
        message: input.message,
        action_url: input.actionUrl || null,
        task_id: input.taskId || null,
        project_id: input.projectId || null,
        metadata: input.metadata || {},
        workspaceId,
      });
    },
  });

  registerCapability({
    key: "task.create",
    description: "Create a task through the existing task service",
    riskLevel: "medium",
    approvalMode: "approval_required",
    inputContract: { required: ["title", "projectId", "addedBy"] },
    validate: (input) => {
      requireFields(input, ["title", "projectId", "addedBy"]);
      if (!isUuid(input.projectId) || !isUuid(input.addedBy)) throw new Error("Invalid task capability identity");
      return true;
    },
    execute: async ({ input, workspaceId }) => {
      const { createTask } = await import("../../services/task.service.js");
      return createTask({
        task: input.title,
        project_id: input.projectId,
        status: input.status || "pending",
        added_by: input.addedBy,
        assigned_to: input.assignedTo || null,
        due_date: input.dueDate || null,
        description: input.description || "",
        priority: input.priority || "medium",
        workspaceId,
      });
    },
  });

  registerCapability({
    key: "workspace_memory.create",
    description: "Create a scoped entry through the existing workspace memory service",
    riskLevel: "medium",
    approvalMode: "approval_required",
    inputContract: { required: ["title", "content", "userId"] },
    validate: (input) => requireFields(input, ["title", "content", "userId"]),
    execute: async ({ input, workspaceId, actor }) => {
      const { createWorkspaceMemoryEntry } = await import("../../services/workspaceMemory.service.js");
      return createWorkspaceMemoryEntry({
        workspaceId,
        userId: input.userId,
        role: actor?.role || "user",
        title: input.title,
        content: input.content,
        tags: input.tags || ["adaptive-runtime"],
        visibility: input.visibility || "workspace",
        sourceEntityType: input.sourceEntityType || null,
        sourceEntityId: input.sourceEntityId || null,
        metadata: input.metadata || {},
        isPinned: Boolean(input.isPinned),
      });
    },
  });

  registerCapability({
    key: "autopilot.analyze",
    description: "Run the existing Autopilot analysis engine",
    riskLevel: "medium",
    approvalMode: "manual_only",
    allowedRoles: ["admin", "owner", "manager"],
    execute: async ({ input, workspaceId }) => {
      const { runAutopilot } = await import("../../services/autopilot.service.js");
      return runAutopilot(workspaceId, input?.projectId || null);
    },
  });

  registerCapability({
    key: "testing_agent.run_task",
    description: "Run tests through the existing Testing Agent service",
    riskLevel: "high",
    approvalMode: "manual_only",
    allowedRoles: ["admin", "owner", "manager"],
    validate: (input) => requireFields(input, ["taskId"]),
    execute: async ({ input, workspaceId, actor }) => {
      const { runTaskTests } = await import("../../services/testingAgent.service.js");
      return runTaskTests({
        workspaceId,
        taskId: input.taskId,
        triggeredBy: actor?.userId || null,
        triggerSource: "adaptive_runtime",
      });
    },
  });

  registerCapability({
    key: "executive_summary.generate",
    description: "Generate the existing role-aware executive dashboard summary",
    riskLevel: "low",
    approvalMode: "manual_only",
    allowedRoles: ["admin", "owner", "manager"],
    execute: async ({ input, workspaceId, actor }) => {
      const { getDashboardExecutiveDetail } = await import("../../services/dashboard.service.js");
      return getDashboardExecutiveDetail({
        workspaceId,
        userId: actor?.userId,
        role: actor?.role || "manager",
        range: input?.range || "30d",
      });
    },
  });

  registerCapability({
    key: "intelligence.workspace.read",
    description: "Read canonical enterprise intelligence without recalculating it",
    riskLevel: "low",
    approvalMode: "automatic",
    autoEligible: true,
    execute: async ({ workspaceId, actor }) => {
      const { getUnifiedIntelligenceSnapshot } = await import("../../intelligence/engine/unifiedIntelligence.engine.js");
      return getUnifiedIntelligenceSnapshot({
        workspaceId,
        userId: actor?.userId || null,
        role: actor?.role || "user",
      });
    },
  });

  registerCapability({
    key: "huddle.action.create_task",
    description: "Promote an approved Huddle action item through the existing Huddle task service",
    riskLevel: "medium",
    approvalMode: "approval_required",
    validate: (input) => requireFields(input, ["sessionId", "artifactId", "actionItemId", "projectId"]),
    execute: async ({ input, workspaceId, actor }) => {
      const { createTaskFromHuddleAction } = await import("../../services/huddleActionTask.service.js");
      return createTaskFromHuddleAction({
        workspaceId,
        sessionId: input.sessionId,
        artifactId: input.artifactId,
        actionItemId: input.actionItemId,
        projectId: input.projectId,
        actorUserId: actor?.userId,
        role: actor?.role || "user",
      });
    },
  });
}
