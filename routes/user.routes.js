// routes/user.routes.js
import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import {
  createUserService,
  getAllUsersService,
  updateUserService,
  deleteUserService,
} from "../services/user.service.js";
import { getUserById } from "../repositories/user.repository.js";

const router = express.Router();

// 🔹 NEW: GET /users/me – current logged-in user (any role)
router.get("/me", authMiddleware, async (req, res) => {
  try {
    const me = await getUserById(req.user.id);
    if (!me) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json(me);
  } catch (err) {
    console.error("Error fetching current user:", err);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

// GET /users (admin & manager)
router.get("/", authMiddleware, async (req, res) => {
  try {
    if (req.user.role === "user") {
      return res
        .status(403)
        .json({ error: "Only admin/manager can view all users" });
    }
    const users = await getAllUsersService();
    res.json(users);
  } catch (err) {
    console.error("Error fetching users:", err);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// POST /users  (ADMIN ONLY)
router.post("/", authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Only admin can create users" });
    }

    const { username, email, password, role, projects } = req.body;
    const user = await createUserService({
      username,
      email,
      password,
      role,
      added_by: req.user.username,
      projects: projects || [],
    });
    res.status(201).json(user);
  } catch (err) {
    console.error("Error creating user:", err);
    res.status(400).json({ error: err.message });
  }
});

// PUT /users/:id  (ADMIN ONLY)
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Only admin can update users" });
    }

    const { username, email, role, projects } = req.body;
    const updated = await updateUserService(req.params.id, {
      username,
      email,
      role,
      projects: projects || [],
    });
    res.json(updated);
  } catch (err) {
    console.error("Error updating user:", err);
    res.status(400).json({ error: err.message });
  }
});

// DELETE /users/:id  (ADMIN ONLY)
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Only admin can delete users" });
    }

    await deleteUserService(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting user:", err);
    res.status(400).json({ error: err.message });
  }
});

export default router;
