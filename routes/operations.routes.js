import express from "express";
import {
  approveOperationsAction,
  executeOperationsAction,
  getOperationsActionById,
  listOperationsActions,
  rejectOperationsAction,
} from "../services/operationsAction.service.js";
import {
  evaluateWorkspaceAutomations,
  getAutomationRules,
  upsertAutomationRule,
} from "../services/operationsAutomation.service.js";
import {
  generateWorkspaceDigest,
  getDigestPreferences,
  listDigestHistory,
  upsertDigestPreferences,
} from "../services/operationsDigest.service.js";
import {
  getDailyOperatingSystem,
  getOperationsCommandCenter,
} from "../services/operationsCommandCenter.service.js";
import {
  listWorkspaceSearchHistory,
  recordWorkspaceSearchClick,
  unifiedWorkspaceSearch,
} from "../services/operationsSearch.service.js";
import {
  createWorkspaceMemoryEntry,
  deleteWorkspaceMemoryEntry,
  getWorkspaceMemoryEntry,
  listWorkspaceMemoryEntries,
  updateWorkspaceMemoryEntry,
} from "../services/workspaceMemory.service.js";

const router = express.Router();

function isPrivilegedRole(role) {
  return ["admin", "owner", "manager"].includes(role);
}

router.get("/command-center", async (req, res) => {
  try {
    const data = await getOperationsCommandCenter({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      role: req.user.role,
    });
    res.json(data);
  } catch (error) {
    console.error("Operations command center failed:", error);
    res.status(500).json({ error: "Failed to load command center" });
  }
});

router.get("/daily-os", async (req, res) => {
  try {
    const data = await getDailyOperatingSystem({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      role: req.user.role,
    });
    res.json(data);
  } catch (error) {
    console.error("Daily OS load failed:", error);
    res.status(500).json({ error: "Failed to load daily operating system" });
  }
});

router.get("/actions", async (req, res) => {
  try {
    const data = await listOperationsActions({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      role: req.user.role,
      status: req.query.status || "pending",
      limit: req.query.limit || 50,
    });
    res.json({ actions: data, count: data.length });
  } catch (error) {
    console.error("Operations actions load failed:", error);
    res.status(500).json({ error: "Failed to load operations actions" });
  }
});

router.get("/actions/:id", async (req, res) => {
  try {
    const action = await getOperationsActionById({
      id: req.params.id,
      workspaceId: req.workspaceId,
      userId: req.user.id,
      role: req.user.role,
    });
    if (!action) {
      return res.status(404).json({ error: "Action not found" });
    }
    res.json(action);
  } catch (error) {
    console.error("Operations action load failed:", error);
    res.status(500).json({ error: "Failed to load action" });
  }
});

router.post("/actions/:id/approve", async (req, res) => {
  try {
    if (!isPrivilegedRole(req.user.role)) {
      return res.status(403).json({ error: "Privileged role required" });
    }

    const action = await approveOperationsAction({
      id: req.params.id,
      workspaceId: req.workspaceId,
      actorId: req.user.id,
      role: req.user.role,
      notes: req.body?.notes || null,
      execute: req.body?.execute === true,
    });
    res.json({ success: true, action });
  } catch (error) {
    console.error("Operations action approve failed:", error);
    res.status(400).json({ error: error.message || "Failed to approve action" });
  }
});

router.post("/actions/:id/reject", async (req, res) => {
  try {
    if (!isPrivilegedRole(req.user.role)) {
      return res.status(403).json({ error: "Privileged role required" });
    }

    const action = await rejectOperationsAction({
      id: req.params.id,
      workspaceId: req.workspaceId,
      actorId: req.user.id,
      role: req.user.role,
      notes: req.body?.notes || null,
    });
    res.json({ success: true, action });
  } catch (error) {
    console.error("Operations action reject failed:", error);
    res.status(400).json({ error: error.message || "Failed to reject action" });
  }
});

router.post("/actions/:id/execute", async (req, res) => {
  try {
    if (!isPrivilegedRole(req.user.role)) {
      return res.status(403).json({ error: "Privileged role required" });
    }

    const action = await executeOperationsAction({
      id: req.params.id,
      workspaceId: req.workspaceId,
      actorId: req.user.id,
      role: req.user.role,
    });
    res.json({ success: true, action });
  } catch (error) {
    console.error("Operations action execute failed:", error);
    res.status(400).json({ error: error.message || "Failed to execute action" });
  }
});

router.get("/automations/rules", async (req, res) => {
  try {
    if (!isPrivilegedRole(req.user.role)) {
      return res.status(403).json({ error: "Privileged role required" });
    }

    const rules = await getAutomationRules(req.workspaceId);
    res.json({ rules });
  } catch (error) {
    console.error("Automation rules load failed:", error);
    res.status(500).json({ error: "Failed to load automation rules" });
  }
});

router.put("/automations/rules/:ruleKey", async (req, res) => {
  try {
    if (!isPrivilegedRole(req.user.role)) {
      return res.status(403).json({ error: "Privileged role required" });
    }

    const rule = await upsertAutomationRule({
      workspaceId: req.workspaceId,
      ruleKey: req.params.ruleKey,
      enabled: req.body?.enabled !== false,
      mode: req.body?.mode || "assist",
      config: req.body?.config || {},
      userId: req.user.id,
    });

    res.json({ success: true, rule });
  } catch (error) {
    console.error("Automation rule update failed:", error);
    res.status(400).json({ error: error.message || "Failed to update automation rule" });
  }
});

router.post("/automations/preview", async (req, res) => {
  try {
    if (!isPrivilegedRole(req.user.role)) {
      return res.status(403).json({ error: "Privileged role required" });
    }

    const result = await evaluateWorkspaceAutomations({
      workspaceId: req.workspaceId,
      dryRun: true,
    });

    res.json(result);
  } catch (error) {
    console.error("Automation preview failed:", error);
    res.status(500).json({ error: "Failed to preview automations" });
  }
});

router.post("/automations/run", async (req, res) => {
  try {
    if (!isPrivilegedRole(req.user.role)) {
      return res.status(403).json({ error: "Privileged role required" });
    }

    const result = await evaluateWorkspaceAutomations({
      workspaceId: req.workspaceId,
      dryRun: false,
    });

    res.json(result);
  } catch (error) {
    console.error("Automation run failed:", error);
    res.status(500).json({ error: "Failed to run automations" });
  }
});

router.get("/digests/preferences", async (req, res) => {
  try {
    const preferences = await getDigestPreferences({
      workspaceId: req.workspaceId,
      userId: req.user.id,
    });
    res.json(preferences);
  } catch (error) {
    console.error("Digest preferences load failed:", error);
    res.status(500).json({ error: "Failed to load digest preferences" });
  }
});

router.put("/digests/preferences", async (req, res) => {
  try {
    const preferences = await upsertDigestPreferences({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      enabled: req.body?.enabled !== false,
      frequency: req.body?.frequency || "daily",
      deliveryHour: req.body?.deliveryHour ?? 8,
      channel: req.body?.channel || "in_app",
      includeSections: req.body?.includeSections || [],
    });

    res.json({ success: true, preferences });
  } catch (error) {
    console.error("Digest preferences update failed:", error);
    res.status(400).json({ error: error.message || "Failed to update digest preferences" });
  }
});

router.post("/digests/preview", async (req, res) => {
  try {
    const result = await generateWorkspaceDigest({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      role: req.user.role,
      deliveryMode: "preview",
    });
    res.json(result);
  } catch (error) {
    console.error("Digest preview failed:", error);
    res.status(500).json({ error: "Failed to preview digest" });
  }
});

router.post("/digests/generate", async (req, res) => {
  try {
    const result = await generateWorkspaceDigest({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      role: req.user.role,
      deliveryMode: "manual",
    });
    res.json(result);
  } catch (error) {
    console.error("Digest generation failed:", error);
    res.status(500).json({ error: "Failed to generate digest" });
  }
});

router.get("/digests/history", async (req, res) => {
  try {
    const history = await listDigestHistory({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      role: req.user.role,
      limit: req.query.limit || 20,
    });
    res.json({ history, count: history.length });
  } catch (error) {
    console.error("Digest history load failed:", error);
    res.status(500).json({ error: "Failed to load digest history" });
  }
});

router.get("/search", async (req, res) => {
  try {
    const result = await unifiedWorkspaceSearch({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      role: req.user.role,
      q: req.query.q || "",
      planFeatures: req.workspace?.planFeatures || [],
    });
    res.json(result);
  } catch (error) {
    console.error("Unified search failed:", error);
    res.status(500).json({ error: "Failed to search workspace" });
  }
});

router.post("/search/click", async (req, res) => {
  try {
    const record = await recordWorkspaceSearchClick({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      query: req.body?.query || "",
      result: req.body?.result || {},
    });
    res.json({ success: true, record });
  } catch (error) {
    console.error("Search click history save failed:", error);
    res.status(400).json({ error: error.message || "Failed to save search click" });
  }
});

router.get("/search/history", async (req, res) => {
  try {
    const data = await listWorkspaceSearchHistory({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      limit: req.query.limit || 20,
    });
    res.json(data);
  } catch (error) {
    console.error("Search history load failed:", error);
    res.status(500).json({ error: "Failed to load search history" });
  }
});

router.get("/memory", async (req, res) => {
  try {
    const entries = await listWorkspaceMemoryEntries({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      role: req.user.role,
      q: req.query.q || "",
      includeArchived: req.query.includeArchived === "true",
      limit: req.query.limit || 50,
    });
    res.json({ entries, count: entries.length });
  } catch (error) {
    console.error("Workspace memory load failed:", error);
    res.status(500).json({ error: "Failed to load workspace memory" });
  }
});

router.get("/memory/:id", async (req, res) => {
  try {
    const entry = await getWorkspaceMemoryEntry({
      id: req.params.id,
      workspaceId: req.workspaceId,
      userId: req.user.id,
      role: req.user.role,
    });
    if (!entry) {
      return res.status(404).json({ error: "Memory entry not found" });
    }
    res.json(entry);
  } catch (error) {
    console.error("Workspace memory entry load failed:", error);
    res.status(500).json({ error: "Failed to load memory entry" });
  }
});

router.post("/memory", async (req, res) => {
  try {
    if (!req.body?.title || !req.body?.content) {
      return res.status(400).json({ error: "title and content are required" });
    }

    const entry = await createWorkspaceMemoryEntry({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      role: req.user.role,
      title: req.body.title,
      content: req.body.content,
      tags: req.body.tags || [],
      visibility: req.body.visibility || "workspace",
      sourceEntityType: req.body.sourceEntityType || null,
      sourceEntityId: req.body.sourceEntityId || null,
      metadata: req.body.metadata || {},
      isPinned: req.body.isPinned === true,
    });

    res.status(201).json(entry);
  } catch (error) {
    console.error("Workspace memory create failed:", error);
    res.status(400).json({ error: error.message || "Failed to create memory entry" });
  }
});

router.put("/memory/:id", async (req, res) => {
  try {
    const entry = await updateWorkspaceMemoryEntry({
      id: req.params.id,
      workspaceId: req.workspaceId,
      userId: req.user.id,
      role: req.user.role,
      patch: req.body || {},
    });
    res.json(entry);
  } catch (error) {
    console.error("Workspace memory update failed:", error);
    res.status(400).json({ error: error.message || "Failed to update memory entry" });
  }
});

router.delete("/memory/:id", async (req, res) => {
  try {
    const result = await deleteWorkspaceMemoryEntry({
      id: req.params.id,
      workspaceId: req.workspaceId,
      userId: req.user.id,
      role: req.user.role,
    });
    res.json(result);
  } catch (error) {
    console.error("Workspace memory delete failed:", error);
    res.status(400).json({ error: error.message || "Failed to delete memory entry" });
  }
});

export default router;
