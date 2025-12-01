// routes/auth.routes.js
import express from "express";
import { loginWithEmail, getCurrentUser } from "../services/auth.service.js";
import { authMiddleware } from "../middleware/auth.middleware.js";

const router = express.Router();

// LOGIN
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const data = await loginWithEmail(email, password);

    res.json(data);
  } catch (err) {
    console.error("Login error:", err);
    res.status(401).json({ error: err.message });
  }
});

// AUTH CHECK – get data of current logged-in user
router.get("/me", authMiddleware, async (req, res) => {
  try {
    const user = await getCurrentUser(req.user.id);
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
