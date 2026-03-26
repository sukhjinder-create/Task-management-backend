import express from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import requireSuperadmin from "../middleware/requireSuperadmin.js";
import pool from "../db.js";
import * as repo from "../repositories/superadminWorkspaces.repository.js";
import {
  updateWorkspaceStatus as updateWorkspaceStatusV2,
  updateWorkspacePlan,
} from "../repositories/workspace.repository.js";
import { emitPlanUpdated } from "../realtime/socket.js";

const router = express.Router();

/**
 * 🔐 All superadmin workspace routes are protected
 */
router.use(requireSuperadmin);

/**
 * POST /superadmin/workspaces
 * Create a workspace + its first admin (owner)
 */
router.post("/", async (req, res) => {
  try {
    const {
      name,
      plan = "basic",
      ownerEmail,
      ownerPassword,
      ownerName,
    } = req.body || {};

    if (!name || !ownerEmail || !ownerPassword) {
      return res.status(400).json({
        error: "name, ownerEmail and ownerPassword are required",
      });
    }

    const passwordHash = await bcrypt.hash(String(ownerPassword), 10);

    const rawIp = req.ip || req.socket?.remoteAddress || "";
    const ipHash = rawIp ? crypto.createHash("sha256").update(rawIp).digest("hex") : null;

    const workspace = await repo.createWorkspace({
      name: String(name).trim(),
      plan: String(plan || "basic").trim(),
      ownerEmail: String(ownerEmail).trim().toLowerCase(),
      ownerPasswordHash: passwordHash,
      ownerName: ownerName ? String(ownerName).trim() : null,
      ipHash,
    });

    return res.status(201).json(workspace);
  } catch (err) {
    console.error("[superadmin] createWorkspace error:", err);
    return res.status(500).json({
      error: err.message || "Failed to create workspace",
    });
  }
});

/**
 * GET /superadmin/workspaces/stats
 * Platform-level stats
 */
router.get("/stats", async (_req, res) => {
  try {
    const stats = await repo.getPlatformStats();
    return res.json(stats);
  } catch (err) {
    console.error("[superadmin] stats error:", err);
    return res.status(500).json({ error: err.message || "Failed to load stats" });
  }
});

/**
 * GET /superadmin/workspaces
 * List all workspaces
 */
router.get("/", async (_req, res) => {
  try {
    const rows = await repo.listWorkspaces();
    return res.json(rows);
  } catch (err) {
    console.error("[superadmin] listWorkspaces error:", err);
    return res.status(500).json({
      error: err.message || "Failed to list workspaces",
    });
  }
});

/**
 * GET /superadmin/workspaces/:workspaceId
 */
router.get("/:workspaceId", async (req, res) => {
  try {
    const ws = await repo.getWorkspace(req.params.workspaceId);
    if (!ws) {
      return res.status(404).json({ error: "Workspace not found" });
    }
    return res.json(ws);
  } catch (err) {
    console.error("[superadmin] getWorkspace error:", err);
    return res.status(500).json({
      error: err.message || "Failed to load workspace",
    });
  }
});

/**
 * PUT /superadmin/workspaces/:workspaceId
 * Update name / plan / member_limit
 * (legacy-compatible)
 */
router.put("/:workspaceId", async (req, res) => {
  try {
    const updates = {};

    if (req.body.name !== undefined) {
      updates.name = String(req.body.name).trim();
    }

    if (req.body.plan !== undefined) {
      updates.plan = String(req.body.plan).trim();
      // Phase 2.2 canonical field
      await updateWorkspacePlan(req.params.workspaceId, updates.plan);
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "Nothing to update" });
    }

    const ws = await repo.updateWorkspace(req.params.workspaceId, updates);

    // Notify all connected users in this workspace to re-fetch their plan
    if (updates.plan !== undefined) {
      emitPlanUpdated(req.params.workspaceId, updates.plan);
    }

    return res.json(ws);
  } catch (err) {
    console.error("[superadmin] updateWorkspace error:", err);
    return res.status(400).json({
      error: err.message || "Update failed",
    });
  }
});

/**
 * PUT /superadmin/workspaces/:workspaceId/status
 * LEGACY ENDPOINT (boolean-based)
 * Translated internally to Phase 2.2 status model
 */
router.put("/:workspaceId/status", async (req, res) => {
  try {
    const { is_active } = req.body;

    if (typeof is_active !== "boolean") {
      return res.status(400).json({
        error: "is_active (boolean) is required",
      });
    }

    const status = is_active ? "active" : "suspended";

    const ws = await updateWorkspaceStatusV2(
      req.params.workspaceId,
      status
    );

    return res.json(ws);
  } catch (err) {
    console.error("[superadmin] updateWorkspaceStatus error:", err);
    return res.status(400).json({
      error: err.message || "Status update failed",
    });
  }
});

/**
 * PUT /superadmin/workspaces/:workspaceId/status-v2
 * Phase 2.2 canonical endpoint
 */
router.put("/:workspaceId/status-v2", async (req, res) => {
  try {
    const { status } = req.body;

    if (!["active", "suspended", "deleted"].includes(status)) {
      return res.status(400).json({
        error: "status must be active | suspended | deleted",
      });
    }

    const ws = await updateWorkspaceStatusV2(
      req.params.workspaceId,
      status
    );

    return res.json(ws);
  } catch (err) {
    console.error("[superadmin] updateWorkspaceStatusV2 error:", err);
    return res.status(400).json({
      error: err.message || "Status update failed",
    });
  }
});

/**
 * GET /superadmin/workspaces/:workspaceId/users
 * List all users in a workspace
 */
router.get("/:workspaceId/users", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, username, email, role, created_at
       FROM users
       WHERE workspace_id = $1
       ORDER BY role DESC, created_at ASC`,
      [req.params.workspaceId]
    );
    return res.json(rows);
  } catch (err) {
    console.error("[superadmin] listUsers error:", err);
    return res.status(500).json({ error: err.message || "Failed to list users" });
  }
});

/**
 * PUT /superadmin/workspaces/:workspaceId/users/:userId
 * Edit a user's username, email, or role
 */
router.put("/:workspaceId/users/:userId", async (req, res) => {
  try {
    const { username, email, role } = req.body;
    const allowed = ["admin", "user", "owner"];
    const sets = [];
    const values = [];
    let idx = 1;

    if (username !== undefined) { sets.push(`username = $${idx++}`); values.push(String(username).trim()); }
    if (email    !== undefined) { sets.push(`email = $${idx++}`);    values.push(String(email).trim().toLowerCase()); }
    if (role     !== undefined) {
      if (!allowed.includes(role)) return res.status(400).json({ error: "role must be admin | user | owner" });
      sets.push(`role = $${idx++}`); values.push(role);
    }
    if (!sets.length) return res.status(400).json({ error: "Nothing to update" });

    values.push(req.params.userId, req.params.workspaceId);
    const { rows, rowCount } = await pool.query(
      `UPDATE users SET ${sets.join(", ")} WHERE id = $${idx} AND workspace_id = $${idx + 1}
       RETURNING id, username, email, role, created_at`,
      values
    );
    if (!rowCount) return res.status(404).json({ error: "User not found in this workspace" });
    return res.json(rows[0]);
  } catch (err) {
    console.error("[superadmin] editUser error:", err);
    return res.status(500).json({ error: err.message || "Failed to update user" });
  }
});

/**
 * DELETE /superadmin/workspaces/:workspaceId/users/:userId
 * Remove a user from a workspace
 */
router.delete("/:workspaceId/users/:userId", async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM users WHERE id = $1 AND workspace_id = $2`,
      [req.params.userId, req.params.workspaceId]
    );
    if (!rowCount) return res.status(404).json({ error: "User not found in this workspace" });
    return res.json({ success: true });
  } catch (err) {
    console.error("[superadmin] deleteUser error:", err);
    return res.status(500).json({ error: err.message || "Failed to delete user" });
  }
});

/**
 * POST /superadmin/workspaces/:workspaceId/reset-password
 * Reset password for a user in a workspace
 */
router.post("/:workspaceId/reset-password", async (req, res) => {
  try {
    const { userId, newPassword } = req.body;
    if (!userId || !newPassword) {
      return res.status(400).json({ error: "userId and newPassword are required" });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }
    const hash = await bcrypt.hash(String(newPassword), 10);
    const { rowCount } = await pool.query(
      `UPDATE users SET password_hash = $1 WHERE id = $2 AND workspace_id = $3`,
      [hash, userId, req.params.workspaceId]
    );
    if (!rowCount) return res.status(404).json({ error: "User not found in this workspace" });
    return res.json({ success: true });
  } catch (err) {
    console.error("[superadmin] resetPassword error:", err);
    return res.status(500).json({ error: err.message || "Failed to reset password" });
  }
});

/**
 * DELETE /superadmin/workspaces/:workspaceId
 * Hard delete — permanently removes workspace and all its data
 */
router.delete("/:workspaceId", async (req, res) => {
  try {
    await repo.hardDeleteWorkspace(req.params.workspaceId);
    return res.json({ success: true });
  } catch (err) {
    console.error("[superadmin] deleteWorkspace error:", err);
    return res.status(500).json({
      error: err.message || "Delete failed",
    });
  }
});

export default router;
