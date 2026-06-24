import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import pool from "../db.js";
import { logAudit } from "../services/audit.service.js";
import { queueImpactedIntelligenceRecalculation } from "../intelligence/realtime/recalculation.service.js";

const router = express.Router();

const DEFAULT_STATUSES = [
  { key: "backlog", label: "Backlog" },
  { key: "pending", label: "Pending" },
  { key: "in-progress", label: "In Progress" },
  { key: "completed", label: "Completed" },
];

const FIXED_EDGE_KEYS = new Set(["backlog", "completed"]);
const FIXED_DEFAULT_KEYS = new Set(DEFAULT_STATUSES.map((status) => status.key));

function historyMeta(projectId, extra = {}) {
  return {
    projectId,
    ...extra,
  };
}

function canManage(user) {
  return user.role === "admin" || user.role === "manager";
}

function queueProjectStatusIntelligence({ workspaceId, projectId, reason, userId, metadata = {} }) {
  queueImpactedIntelligenceRecalculation({
    workspaceId,
    reason,
    userIds: [userId],
    projectIds: [projectId],
    sourceType: "project_status",
    sourceId: metadata.statusColumnId || projectId,
    metadata,
  });
}

function normalizeKey(value = "") {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeLabel(value = "") {
  return String(value).trim().replace(/\s+/g, " ").toLowerCase();
}

function defaultLabelForKey(key) {
  const found = DEFAULT_STATUSES.find((status) => status.key === key);
  if (found) return found.label;
  return String(key)
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

async function getProjectStatuses(client, projectId) {
  const { rows } = await client.query(
    `SELECT *
       FROM project_statuses
      WHERE project_id = $1
      ORDER BY sort_order ASC, created_at ASC`,
    [projectId]
  );
  return rows;
}

async function resequenceStatuses(client, projectId, orderedStatuses) {
  for (let index = 0; index < orderedStatuses.length; index += 1) {
    await client.query(
      `UPDATE project_statuses
          SET sort_order = $1,
              updated_at = NOW()
        WHERE id = $2`,
      [index + 1, orderedStatuses[index].id]
    );
  }
}

function buildCanonicalOrder(statuses) {
  const byKey = new Map(statuses.map((status) => [status.key, status]));
  const ordered = [];

  const backlog = byKey.get("backlog");
  const completed = byKey.get("completed");
  if (backlog) ordered.push(backlog);

  const middle = statuses.filter(
    (status) => status.key !== "backlog" && status.key !== "completed"
  );
  ordered.push(...middle);

  if (completed) ordered.push(completed);
  return ordered;
}

async function ensureDefaultStatuses(client, projectId) {
  let statuses = await getProjectStatuses(client, projectId);
  const existingKeys = new Set(statuses.map((status) => status.key));

  for (const [index, status] of DEFAULT_STATUSES.entries()) {
    if (existingKeys.has(status.key)) continue;
    await client.query(
      `INSERT INTO project_statuses (project_id, key, label, sort_order, is_default)
       VALUES ($1, $2, $3, $4, $5)`,
      [projectId, status.key, status.label, index + 1, true]
    );
  }

  statuses = await getProjectStatuses(client, projectId);

  for (const fixed of DEFAULT_STATUSES) {
    const existing = statuses.find((status) => status.key === fixed.key);
    if (!existing) continue;
    if (existing.label !== fixed.label || existing.is_default !== true) {
      await client.query(
        `UPDATE project_statuses
            SET label = $1,
                is_default = true,
                updated_at = NOW()
          WHERE id = $2`,
        [fixed.label, existing.id]
      );
    }
  }

  statuses = await getProjectStatuses(client, projectId);
  const ordered = buildCanonicalOrder(statuses);
  await resequenceStatuses(client, projectId, ordered);
  return getProjectStatuses(client, projectId);
}

async function withProjectStatuses(projectId, callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const statuses = await ensureDefaultStatuses(client, projectId);
    const result = await callback(client, statuses);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

router.get("/global", authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT key AS status_key, label
         FROM project_statuses
        ORDER BY label`
    );
    res.json(rows);
  } catch (err) {
    console.error("Error loading global statuses:", err);
    res.status(500).json({ error: "Failed to load global statuses" });
  }
});

router.get("/:projectId", authMiddleware, async (req, res) => {
  try {
    const { projectId } = req.params;
    const statuses = await withProjectStatuses(projectId, async (_client, rows) => rows);
    res.json(statuses);
  } catch (err) {
    console.error("Error loading project statuses:", err);
    res.status(500).json({ error: "Failed to load statuses" });
  }
});

router.post("/:projectId", authMiddleware, async (req, res) => {
  try {
    if (!canManage(req.user)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const { projectId } = req.params;
    const submittedKey = normalizeKey(req.body?.key);
    const submittedLabel = String(req.body?.label || "").trim();
    const label = submittedLabel || defaultLabelForKey(submittedKey);

    if (!submittedKey || !label) {
      return res.status(400).json({ error: "key and label are required" });
    }

    if (FIXED_DEFAULT_KEYS.has(submittedKey)) {
      return res.status(400).json({ error: "This default column already exists" });
    }

    const created = await withProjectStatuses(projectId, async (client, statuses) => {
      if (statuses.length >= 15) {
        throw new Error("Maximum 15 status columns per project");
      }

      const duplicateKey = statuses.some((status) => status.key === submittedKey);
      const duplicateLabel = statuses.some(
        (status) => normalizeLabel(status.label) === normalizeLabel(label)
      );
      if (duplicateKey || duplicateLabel) {
        throw new Error("A column with the same name already exists");
      }

      const completed = statuses.find((status) => status.key === "completed");
      const insertOrder = completed ? completed.sort_order : statuses.length + 1;
      const newSortOrder = Number(insertOrder) || statuses.length + 1;

      await client.query(
        `UPDATE project_statuses
            SET sort_order = sort_order + 1,
                updated_at = NOW()
          WHERE project_id = $1
            AND sort_order >= $2`,
        [projectId, newSortOrder]
      );

      const insertRes = await client.query(
        `INSERT INTO project_statuses (project_id, key, label, sort_order, is_default)
         VALUES ($1, $2, $3, $4, false)
         RETURNING *`,
        [projectId, submittedKey, label, newSortOrder]
      );

      const refreshed = await getProjectStatuses(client, projectId);
      const ordered = buildCanonicalOrder(refreshed);
      await resequenceStatuses(client, projectId, ordered);
      return insertRes.rows[0];
    });

    await logAudit({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      action: "project.history.status_column.created",
      entityType: "project",
      entityId: projectId,
      newValue: {
        key: created.key,
        label: created.label,
        sort_order: created.sort_order,
      },
      metadata: historyMeta(projectId, {
        statusColumnId: created.id,
        statusKey: created.key,
      }),
    });
    queueProjectStatusIntelligence({
      workspaceId: req.workspaceId,
      projectId,
      reason: "project_status_changed",
      userId: req.user.id,
      metadata: {
        action: "created",
        statusColumnId: created.id,
        statusKey: created.key,
        label: created.label,
      },
    });

    res.status(201).json(created);
  } catch (err) {
    console.error("Error creating status:", err);
    res.status(400).json({ error: err.message });
  }
});

router.put("/:id", authMiddleware, async (req, res) => {
  try {
    if (!canManage(req.user)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const { id } = req.params;
    const { label, sort_order } = req.body;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const currentRes = await client.query(
        `SELECT * FROM project_statuses WHERE id = $1`,
        [id]
      );
      const current = currentRes.rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Status not found" });
      }

      const statuses = await ensureDefaultStatuses(client, current.project_id);

      if (label != null) {
        const normalizedLabel = normalizeLabel(label);
        if (!normalizedLabel) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Column name is required" });
        }

        if (FIXED_DEFAULT_KEYS.has(current.key) && label.trim() !== defaultLabelForKey(current.key)) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Default columns cannot be renamed" });
        }

        const duplicateLabel = statuses.some(
          (status) =>
            status.id !== current.id &&
            normalizeLabel(status.label) === normalizedLabel
        );
        if (duplicateLabel) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "A column with the same name already exists" });
        }

        await client.query(
          `UPDATE project_statuses
              SET label = $1,
                  updated_at = NOW()
            WHERE id = $2`,
          [label.trim(), id]
        );
      }

      if (sort_order != null) {
        const latest = await getProjectStatuses(client, current.project_id);
        const currentStatus = latest.find((status) => status.id === id);
        if (!currentStatus) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Status not found" });
        }

        if (FIXED_EDGE_KEYS.has(currentStatus.key)) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "This column position is fixed" });
        }

        const middle = latest.filter(
          (status) => status.key !== "backlog" && status.key !== "completed"
        );
        const requestedSortOrder = Number(sort_order);
        const safeRequestedSortOrder = Number.isFinite(requestedSortOrder)
          ? requestedSortOrder
          : currentStatus.sort_order;
        const targetIndex = Math.max(
          0,
          Math.min(safeRequestedSortOrder - 2, middle.length - 1)
        );
        const currentIndex = middle.findIndex((status) => status.id === id);
        if (currentIndex !== -1 && currentIndex !== targetIndex) {
          const [moved] = middle.splice(currentIndex, 1);
          middle.splice(targetIndex, 0, moved);
          const backlog = latest.find((status) => status.key === "backlog");
          const completed = latest.find((status) => status.key === "completed");
          const ordered = [backlog, ...middle, completed].filter(Boolean);
          await resequenceStatuses(client, current.project_id, ordered);
        }
      }

      const finalRes = await client.query(
        `SELECT *
           FROM project_statuses
          WHERE id = $1`,
        [id]
      );
      const finalStatus = finalRes.rows[0];
      await client.query("COMMIT");

      if (label != null || sort_order != null) {
        await logAudit({
          workspaceId: req.workspaceId,
          userId: req.user.id,
          action: "project.history.status_column.updated",
          entityType: "project",
          entityId: current.project_id,
          oldValue: {
            key: current.key,
            label: current.label,
            sort_order: current.sort_order,
          },
          newValue: finalStatus
            ? {
                key: finalStatus.key,
                label: finalStatus.label,
                sort_order: finalStatus.sort_order,
              }
            : null,
          metadata: historyMeta(current.project_id, {
            statusColumnId: current.id,
            statusKey: current.key,
          }),
        });
        queueProjectStatusIntelligence({
          workspaceId: req.workspaceId,
          projectId: current.project_id,
          reason: "project_status_changed",
          userId: req.user.id,
          metadata: {
            action: "updated",
            statusColumnId: current.id,
            statusKey: finalStatus?.key || current.key,
            labelChanged: label != null,
            orderChanged: sort_order != null,
          },
        });
      }
      res.json(finalStatus);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Error updating status:", err);
    res.status(400).json({ error: err.message });
  }
});

router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    if (!canManage(req.user)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const { id } = req.params;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const statusRes = await client.query(
        `SELECT * FROM project_statuses WHERE id = $1`,
        [id]
      );
      const status = statusRes.rows[0];
      if (!status) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Status not found" });
      }

      await ensureDefaultStatuses(client, status.project_id);

      if (FIXED_DEFAULT_KEYS.has(status.key)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Default columns cannot be deleted" });
      }

      const taskRes = await client.query(
        `SELECT 1
           FROM tasks
          WHERE project_id = $1
            AND status = $2
          LIMIT 1`,
        [status.project_id, status.key]
      );
      if (taskRes.rows.length > 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Cannot delete a column that has tasks" });
      }

      await client.query("DELETE FROM project_statuses WHERE id = $1", [id]);
      const refreshed = await getProjectStatuses(client, status.project_id);
      const ordered = buildCanonicalOrder(refreshed);
      await resequenceStatuses(client, status.project_id, ordered);
      await client.query("COMMIT");

      await logAudit({
        workspaceId: req.workspaceId,
        userId: req.user.id,
        action: "project.history.status_column.deleted",
        entityType: "project",
        entityId: status.project_id,
        oldValue: {
          key: status.key,
          label: status.label,
          sort_order: status.sort_order,
        },
        metadata: historyMeta(status.project_id, {
          statusColumnId: status.id,
          statusKey: status.key,
        }),
      });
      queueProjectStatusIntelligence({
        workspaceId: req.workspaceId,
        projectId: status.project_id,
        reason: "project_status_changed",
        userId: req.user.id,
        metadata: {
          action: "deleted",
          statusColumnId: status.id,
          statusKey: status.key,
          label: status.label,
        },
      });

      res.json({ success: true });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Error deleting status:", err);
    res.status(400).json({ error: err.message });
  }
});

export default router;
