// execution/adapters.js
//
// EWIP V3 — capability adapters WIRED TO THE REAL PRODUCT SERVICES. Each adapter calls
// an existing service function (task.service, notification.service …) via a lazy
// dynamic import, so merely loading the registry does NOT pull in the DB layer (keeps
// hermetic tests clean). Adapters are invoked ONLY when the side-effects safety gate is
// ON; otherwise the runtime returns a deterministic dry-run and these never run. Real
// side effects are therefore inert by default. UNVERIFIED AT RUNTIME (no reachable DB).

/** Map: capabilityKey -> async ({ input, context, workspaceId }) => { ok, entity?, raw? } */
export const REAL_ADAPTERS = {
  "work.task.create": async ({ input, context, workspaceId }) => {
    const { createTask } = await import("../services/task.service.js");
    const t = await createTask({
      task: input.title, project_id: input.projectId, added_by: context.actorId,
      assigned_to: input.assignedTo ?? null, due_date: input.dueDate ?? null,
      description: input.description ?? "", priority: input.priority ?? "medium", workspaceId,
    });
    return { ok: true, entity: { type: "Task", id: t?.id ?? null }, raw: t };
  },

  "work.task.assign": async ({ input }) => {
    const { updateTaskAsAdminOrManager } = await import("../services/task.service.js");
    const t = await updateTaskAsAdminOrManager(input.taskId, { assigned_to: input.assignedTo });
    return { ok: true, entity: { type: "Task", id: input.taskId }, raw: t };
  },

  "work.task.update": async ({ input }) => {
    const { updateTaskAsAdminOrManager } = await import("../services/task.service.js");
    const t = await updateTaskAsAdminOrManager(input.taskId, input.changes || {});
    return { ok: true, entity: { type: "Task", id: input.taskId }, raw: t };
  },

  "work.task.priority": async ({ input }) => {
    const { updateTaskAsAdminOrManager } = await import("../services/task.service.js");
    const t = await updateTaskAsAdminOrManager(input.taskId, { priority: input.priority });
    return { ok: true, entity: { type: "Task", id: input.taskId }, raw: t };
  },

  "work.team.notify": async ({ input, workspaceId }) => {
    const { notifyUser } = await import("../services/notification.service.js");
    await notifyUser({ userId: input.userId, workspaceId, type: input.type || "info", title: input.title, message: input.message, link: input.link || null });
    return { ok: true, entity: { type: "User", id: input.userId } };
  },

  "work.risk.escalate": async ({ input, workspaceId }) => {
    const { notifyUser } = await import("../services/notification.service.js");
    await notifyUser({ userId: input.userId, workspaceId, type: "escalation", title: input.title || "Risk escalated", message: input.message || "A risk requires your attention", link: input.link || null });
    return { ok: true, entity: { type: "User", id: input.userId } };
  },
};
