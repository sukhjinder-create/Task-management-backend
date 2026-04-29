import express from "express";
import multer from "multer";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import bcrypt from "bcryptjs";
import pool from "../db.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requireWorkspaceForUser } from "../middleware/workspace.middleware.js";
import {
  createUserService,
  getAllUsersService,
  updateUserService,
  deleteUserService,
} from "../services/user.service.js";
import { getUserById, updateAvatarUrl } from "../repositories/user.repository.js";
import { logAudit } from "../services/audit.service.js";
import { getRequestAuditContext } from "../utils/requestContext.util.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadDir = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Use memory storage — file is uploaded to Supabase Storage, URL stored in DB
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are allowed"));
  },
});

const router = express.Router();

function userSnapshot(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    projects: Array.isArray(user.projects) ? user.projects : [],
    workspace_id: user.workspace_id ?? null,
  };
}

/**
 * =====================================================
 * 🔐 ALL ROUTES BELOW:
 * - Require valid auth
 * - Require a workspace
 * - Superadmins are blocked
 * =====================================================
 */
router.use(authMiddleware);
router.use(requireWorkspaceForUser);

/**
 * 🔹 POST /users/me/avatar – upload profile photo
 */
router.post("/me/avatar", avatarUpload.single("avatar"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ error: "Storage not configured" });
    }

    const ext = path.extname(req.file.originalname) || ".jpg";
    const objectPath = `avatars/${req.user.id}${ext}`;

    const uploadRes = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${objectPath}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          "Content-Type": req.file.mimetype,
          "x-upsert": "true",
        },
        body: req.file.buffer,
      }
    );

    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      throw new Error(`Supabase Storage upload failed: ${err}`);
    }

    const avatarUrl = `${SUPABASE_URL}/storage/v1/object/public/${objectPath}`;
    const updated = await updateAvatarUrl(req.user.id, avatarUrl);
    res.json({ avatar_url: updated.avatar_url });
  } catch (err) {
    console.error("Error uploading avatar:", err);
    res.status(500).json({ error: err.message || "Failed to upload avatar" });
  }
});

/**
 * 🔹 GET /users/me – current logged-in user (workspace scoped)
 */
router.get("/me", async (req, res) => {
  try {
    const me = await getUserById(req.user.id);

    if (!me) {
      return res.status(404).json({ error: "User not found" });
    }

    // 🔐 HARD CHECK: user must belong to same workspace
    if (String(me.workspace_id) !== String(req.workspaceId)) {
      return res.status(403).json({ error: "Workspace access denied" });
    }

    res.json(me);
  } catch (err) {
    console.error("Error fetching current user:", err);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

/**
 * 🔹 GET /users/:id – workspace-scoped member profile
 * Any authenticated workspace user can view profiles of members in the same workspace.
 */
router.get("/:id", async (req, res) => {
  try {
    const targetUser = await getUserById(req.params.id);

    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }

    if (String(targetUser.workspace_id) !== String(req.workspaceId)) {
      return res.status(403).json({ error: "Workspace access denied" });
    }

    res.json(targetUser);
  } catch (err) {
    console.error("Error fetching user profile:", err);
    res.status(500).json({ error: "Failed to fetch user profile" });
  }
});

/**
 * 🔹 GET /users/:id/ai-preference
 * 🔐 User can read ONLY their own AI preference (workspace scoped)
 */
router.get("/:id/ai-preference", async (req, res) => {
  try {
    const { id } = req.params;

    // 🔐 user can only access their own preference
    if (String(req.user.id) !== String(id)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // 🔐 ensure same workspace
    const user = await getUserById(id);
    if (!user || String(user.workspace_id) !== String(req.workspaceId)) {
      return res.status(403).json({ error: "Workspace access denied" });
    }

    const { rows } = await pool.query(
      `
      SELECT ai_reply_enabled
      FROM user_preferences
      WHERE user_id = $1
      `,
      [id]
    );

    res.json({
      aiReplyEnabled: rows[0]?.ai_reply_enabled ?? false, // default OFF — users must opt in
    });
  } catch (err) {
    console.error("Error fetching AI preference:", err);
    res.status(500).json({ error: "Failed to fetch AI preference" });
  }
});

/**
 * 🔹 PUT /users/:id/ai-preference
 * 🔐 User can update ONLY their own AI preference
 */
router.put("/:id/ai-preference", async (req, res) => {
  try {
    const { id } = req.params;
    const { aiReplyEnabled } = req.body;

    if (String(req.user.id) !== String(id)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // 🔐 ensure same workspace
    const user = await getUserById(id);
    if (!user || String(user.workspace_id) !== String(req.workspaceId)) {
      return res.status(403).json({ error: "Workspace access denied" });
    }

    await pool.query(
      `
      INSERT INTO user_preferences (user_id, ai_reply_enabled)
      VALUES ($1, $2)
      ON CONFLICT (user_id)
      DO UPDATE SET ai_reply_enabled = EXCLUDED.ai_reply_enabled
      `,
      [id, aiReplyEnabled === true]
    );

    // When AI auto-reply is turned OFF, clear the AI service's in-memory and
    // persisted conversation history for this user so stale context is not
    // reused if they re-enable later.
    if (aiReplyEnabled === false) {
      const aiUrl = process.env.AI_SERVICE_URL;
      const aiSecret = process.env.AI_SERVICE_SECRET;
      if (aiUrl && aiSecret) {
        const clearUrl = new URL("/internal/clear-dm-context", aiUrl).origin +
          "/internal/clear-dm-context";
        fetch(clearUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${aiSecret}`,
          },
          body: JSON.stringify({ userId: id, workspaceId: req.workspaceId, recipientName: user.username }),
        }).catch((err) =>
          console.warn("[ai-preference] clear-dm-context call failed:", err.message)
        );
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Error updating AI preference:", err);
    res.status(500).json({ error: "Failed to update AI preference" });
  }
});

/**
 * 🔹 GET /users
 * 🔐 RETURNS ONLY USERS FROM SAME WORKSPACE
 */
router.get("/", async (req, res) => {
  try {
    // Optional ?projectIds=x,y  → return only users who have tasks in those projects
    const { projectIds } = req.query;
    if (projectIds) {
      const ids = projectIds.split(",").map((s) => s.trim()).filter(Boolean);
      if (ids.length > 0) {
        const { rows } = await pool.query(
          `SELECT DISTINCT u.id, u.username, u.email, u.role, u.avatar_url
           FROM users u
           JOIN tasks t ON t.assigned_to = u.id
           JOIN workspace_users wu ON wu.user_id = u.id AND wu.workspace_id = $1
           WHERE t.workspace_id = $1
             AND t.project_id = ANY($2)
             AND wu.billing_status != 'pending'`,
          [req.workspaceId, ids]
        );
        return res.json(rows.map((u) => ({
          id: u.id, username: u.username, email: u.email, role: u.role, avatar_url: u.avatar_url || null,
        })));
      }
    }

    const users = await getAllUsersService({
      workspaceId: req.workspaceId, // ✅ correct
    });

    const safeUsers = (users || []).map((u) => ({
      id: u.id,
      username: u.username,
      email: u.email,
      role: u.role,
      avatar_url: u.avatar_url || null,
    }));

    res.json(safeUsers);
  } catch (err) {
    console.error("Error fetching users:", err);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

/**
 * 🔹 POST /users – WORKSPACE ADMIN ONLY
 */
router.post("/", async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Only admin can create users" });
    }

    const { username, email, password, role = "user", projects } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    if (!["admin", "manager", "user"].includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }

    if (role === "manager" && (!Array.isArray(projects) || projects.length === 0)) {
      return res.status(400).json({ error: "At least one project must be assigned when creating a manager" });
    }

    const user = await createUserService({
      username,
      email,
      password,
      role,
      added_by: req.user.username,
      projects: projects || [],
      workspace_id: req.workspaceId, // ✅ correct
    });

    await logAudit({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      action: "user.create",
      entityType: "user",
      entityId: user.id,
      newValue: userSnapshot(user),
      ...getRequestAuditContext(req, {
        targetUserId: user.id,
        targetUsername: user.username,
      }),
    });

    res.status(201).json(user);
  } catch (err) {
    console.error("Error creating user:", err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * 🔹 PUT /users/:id – WORKSPACE ADMIN ONLY
 */
router.put("/:id", async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Only admin can update users" });
    }

    const targetUser = await getUserById(req.params.id);
    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }

    // 🔐 HARD BLOCK: cross-workspace update
    if (String(targetUser.workspace_id) !== String(req.workspaceId)) {
      return res.status(403).json({ error: "Workspace access denied" });
    }

    const { username, email, role, projects } = req.body;

    if (role && !["admin", "manager", "user"].includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }

    if (role === "manager" && (!Array.isArray(projects) || projects.length === 0)) {
      return res.status(400).json({ error: "At least one project must be assigned to a manager" });
    }

    // ✅ FIX: pass workspaceId
    const updated = await updateUserService(
      req.params.id,
      { username, email, role, projects: projects || [] },
      req.workspaceId
    );

    await logAudit({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      action: "user.update",
      entityType: "user",
      entityId: updated.id,
      oldValue: userSnapshot(targetUser),
      newValue: userSnapshot(updated),
      ...getRequestAuditContext(req, {
        targetUserId: updated.id,
        targetUsername: updated.username,
      }),
    });

    res.json(updated);
  } catch (err) {
    console.error("Error updating user:", err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * 🔹 DELETE /users/:id – WORKSPACE ADMIN ONLY
 */
router.delete("/:id", async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Only admin can delete users" });
    }

    const targetUser = await getUserById(req.params.id);
    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }

    // 🔐 HARD BLOCK: cross-workspace delete
    if (String(targetUser.workspace_id) !== String(req.workspaceId)) {
      return res.status(403).json({ error: "Workspace access denied" });
    }

    // ✅ FIX: pass workspaceId
    await deleteUserService(req.params.id, req.workspaceId);

    await logAudit({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      action: "user.delete",
      entityType: "user",
      entityId: req.params.id,
      oldValue: userSnapshot(targetUser),
      ...getRequestAuditContext(req, {
        targetUserId: req.params.id,
        targetUsername: targetUser.username,
      }),
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting user:", err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * 🔹 POST /users/:id/reset-password – WORKSPACE ADMIN ONLY
 */
router.post("/:id/reset-password", async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Only admin can reset passwords" });
    }

    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    const { getUserById } = await import("../repositories/user.repository.js");
    const target = await getUserById(req.params.id);
    if (!target) return res.status(404).json({ error: "User not found" });
    if (String(target.workspace_id) !== String(req.workspaceId)) {
      return res.status(403).json({ error: "Workspace access denied" });
    }

    const hash = await bcrypt.hash(String(newPassword), 10);
    await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, req.params.id]);

    return res.json({ success: true });
  } catch (err) {
    console.error("Error resetting password:", err);
    return res.status(500).json({ error: err.message || "Failed to reset password" });
  }
});

export default router;
