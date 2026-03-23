// src/routes/workspace.routes.js
console.log("🔥 workspace.routes.js LOADED");

import express from "express";
import workspaceService from "../services/workspace.service.js";
import * as workspaceRepo from "../repositories/workspace.repository.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { allowRoles } from "../middleware/role.middleware.js";
import { requireWorkspaceForUser } from "../middleware/workspace.middleware.js";
import { ensureWorkspaceMember } from "../middleware/ensureWorkspaceMember.middleware.js";
import pool from "../db.js";

const router = express.Router();

// All workspace routes require auth
router.use(authMiddleware);

/**
 * Create workspace
 * - Only superadmin can create new workspaces (global)
 * body: { name, slug, billing_plan, max_members, metadata }
 */
router.post("/", allowRoles("superadmin"), async (req, res) => {
  try {
    const ownerId = req.user?.id || null;
    const payload = {
      name: req.body.name,
      slug: req.body.slug || null,
      billing_plan: req.body.billing_plan || null,
      max_members: req.body.max_members || 10,
      metadata: req.body.metadata || null,
      createdBy: ownerId,
    };
    const ws = await workspaceService.create(payload);
    res.status(201).json(ws);
  } catch (err) {
    console.error("[workspaces.post] error:", err?.message || err);
    res.status(400).json({ error: err.message || "Failed to create workspace" });
  }
});

/**
 * List workspaces — superadmin only
 */
router.get("/", allowRoles("superadmin"), async (req, res) => {
  try {
    const ws = await workspaceService.list();
    res.json(ws);
  } catch (err) {
    console.error("[workspaces.get] error:", err?.message || err);
    res.status(400).json({ error: err.message || "Failed to list workspaces" });
  }
});

/**
 * 🔹 GET /workspace/ai-settings
 */
router.get(
  "/ai-settings",
  requireWorkspaceForUser,
  async (req, res) => {
    try {
      const { rows } = await pool.query(
        `
        SELECT ai_enabled, ai_auto_reply, ai_name
        FROM workspace_ai_settings
        WHERE workspace_id = $1
        `,
        [req.workspaceId]
      );

      const settings = rows[0] || {
        ai_enabled: false,
        ai_auto_reply: false,
        ai_name: 'AI Assistant',
      };

      res.json(settings);
    } catch (err) {
      console.error("[workspace.ai-settings.get]", err);
      res.status(500).json({ error: "Failed to fetch AI settings" });
    }
  }
);

/**
 * 🔹 PUT /workspace/ai-settings
 */
router.put(
  "/ai-settings",
  requireWorkspaceForUser,
  async (req, res) => {
    try {
      const caller = req.user;
if (!["admin"].includes(caller.role)) {
  const membership = await workspaceService.getMembership(
    req.workspaceId,
    String(caller.id)
  );

  if (!membership || membership.role !== "admin") {
    return res.status(403).json({ error: "Only admins allowed" });
  }
}


      const {
        ai_enabled = false,
        ai_auto_reply = false,
        ai_name = 'AI Assistant',
      } = req.body;

      await pool.query(
        `
        INSERT INTO workspace_ai_settings (workspace_id, ai_enabled, ai_auto_reply, ai_name)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (workspace_id)
        DO UPDATE SET
          ai_enabled = EXCLUDED.ai_enabled,
          ai_auto_reply = EXCLUDED.ai_auto_reply,
          ai_name = EXCLUDED.ai_name,
          updated_at = now()
        `,
        [req.workspaceId, ai_enabled, ai_auto_reply, ai_name]
      );

      res.json({ success: true });
    } catch (err) {
      console.error("[workspace.ai-settings.put]", err);
      res.status(500).json({ error: "Failed to update AI settings" });
    }
  }
);

/**
 * Get single workspace
 * - superadmin OR a member of the workspace may read it
 */
router.get("/:id", requireWorkspaceForUser, async (req, res) => {
  try {
    const id = req.params.id;

    // superadmin can access any workspace
    if (req.user?.role === "superadmin") {
      const ws = await workspaceService.getOne(id);
      if (!ws) return res.status(404).json({ error: "Workspace not found" });
      return res.json(ws);
    }

    // otherwise ensure user is member of that workspace
    const membership = await workspaceService.getMembership(id, String(req.user.id));
    if (!membership) {
      return res.status(403).json({ error: "You are not a member of this workspace" });
    }

    const ws = await workspaceService.getOne(id);
    if (!ws) return res.status(404).json({ error: "Workspace not found" });
    res.json(ws);
  } catch (err) {
    console.error("[workspaces.getOne] error:", err?.message || err);
    res.status(400).json({ error: err.message || "Failed to fetch workspace" });
  }
});

/**
 * Update workspace metadata (superadmin or workspace admin)
 * body: { name, slug, billing_plan, max_members, metadata }
 */
router.put("/:id", requireWorkspaceForUser, async (req, res) => {
  try {
    const id = req.params.id;
    const caller = req.user;

    // Only superadmin OR workspace admin can update
    if (caller.role !== "superadmin") {
      const membership = await workspaceService.getMembership(id, String(caller.id));
      if (!membership || membership.role !== "admin") {
        return res.status(403).json({ error: "Only superadmin or workspace admins can update the workspace" });
      }
    }

    // minimal update logic — delegate to repo or service as you prefer.
    // We'll perform a simple update here using pool (non-destructive).
    const fields = [];
    const values = [];
    let idx = 1;

    if (req.body.name) {
      fields.push(`name = $${idx++}`);
      values.push(req.body.name);
    }
    if (req.body.slug) {
      fields.push(`slug = $${idx++}`);
      values.push(req.body.slug);
    }
    if (req.body.billing_plan !== undefined) {
      fields.push(`billing_plan = $${idx++}`);
      values.push(req.body.billing_plan);
    }
    if (req.body.max_members !== undefined) {
      fields.push(`max_members = $${idx++}`);
      values.push(req.body.max_members);
    }
    if (req.body.metadata !== undefined) {
      fields.push(`metadata = $${idx++}`);
      values.push(req.body.metadata);
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: "No updatable fields provided" });
    }

    values.push(id); // last param = workspace id

    const q = `UPDATE workspaces SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`;
    const { rows } = await pool.query(q, values);
    if (!rows || rows.length === 0) return res.status(404).json({ error: "Workspace not found" });

    res.json(rows[0]);
  } catch (err) {
    console.error("[workspaces.put] error:", err?.message || err);
    res.status(400).json({ error: err.message || "Failed to update workspace" });
  }
});

/**
 * Add member to workspace
 * - Can be done by superadmin OR by workspace admin
 * - body: { user_id, role }
 *
 * NOTE: addMember in service will throw a friendly error when user already belongs to another workspace.
 */
router.post("/:id/members", requireWorkspaceForUser, async (req, res) => {
  try {
    const workspaceId = req.params.id;
    const caller = req.user;

    // validate user_id in body
    const userIdToAdd = req.body.user_id;
    if (!userIdToAdd) return res.status(400).json({ error: "user_id is required" });

    // superadmin can always add
    if (caller.role === "superadmin") {
      const added = await workspaceService.addMember({
        workspaceId,
        userId: userIdToAdd,
        role: req.body.role || "member",
      });
      return res.status(201).json(added);
    }

    // otherwise ensure caller is workspace admin
    const callerMembership = await workspaceService.getMembership(workspaceId, String(caller.id));
    if (!callerMembership || callerMembership.role !== "admin") {
      return res.status(403).json({ error: "Only workspace admins can add members" });
    }

    // enforce max_members etc inside service
    const added = await workspaceService.addMember({
      workspaceId,
      userId: userIdToAdd,
      role: req.body.role || "member",
    });

    res.status(201).json(added);
  } catch (err) {
    console.error("[workspaces.addMember] error:", err?.message || err);

    // Friendly handling of DB-unique violation surfaced by service
    const msg = err?.message || "Failed to add member";
    if (msg.includes("already belongs to another workspace")) {
      return res.status(409).json({ error: msg });
    }

    // Generic errors
    return res.status(400).json({ error: msg });
  }
});

/**
 * Remove member from workspace
 * - allowed for workspace admin or superadmin
 */
router.delete("/:id/members/:userId", requireWorkspaceForUser, async (req, res) => {
  try {
    const workspaceId = req.params.id;
    const caller = req.user;
    const targetUserId = req.params.userId;

    if (caller.role !== "superadmin") {
      const callerMembership = await workspaceService.getMembership(workspaceId, String(caller.id));
      if (!callerMembership || callerMembership.role !== "admin") {
        return res.status(403).json({ error: "Only workspace admins can remove members" });
      }
    }

    await workspaceService.removeMember({ workspaceId, userId: targetUserId });
    res.json({ message: "Member removed" });
  } catch (err) {
    console.error("[workspaces.removeMember] error:", err?.message || err);
    res.status(400).json({ error: err.message || "Failed to remove member" });
  }
});

/**
 * Get workspace members (workspace admin or any member)
 */
router.get("/:id/members", requireWorkspaceForUser, ensureWorkspaceMember(), async (req, res) => {
  try {
    const workspaceId = req.params.id;

    // Query workspace_users with user info
    const q = `
      SELECT wu.user_id, wu.role, wu.created_at, u.username, u.email
      FROM workspace_users wu
      LEFT JOIN users u ON u.id = wu.user_id
      WHERE wu.workspace_id = $1
      ORDER BY wu.created_at ASC
    `;
    const { rows } = await pool.query(q, [workspaceId]);

    res.json(rows || []);
  } catch (err) {
    console.error("[workspaces.getMembers] error:", err?.message || err);
    res.status(400).json({ error: err.message || "Failed to fetch members" });
  }
});

export default router;
