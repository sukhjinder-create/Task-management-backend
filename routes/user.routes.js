import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadDir = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, "avatar-" + unique + path.extname(file.originalname));
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are allowed"));
  },
});

const router = express.Router();

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

    const avatarUrl = `/uploads/${req.file.filename}`;
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
      aiReplyEnabled: rows[0]?.ai_reply_enabled ?? true, // default ON
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

    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting user:", err);
    res.status(400).json({ error: err.message });
  }
});

export default router;
