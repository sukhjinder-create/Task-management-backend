// routes/superadminAuth.routes.js
import express from "express";
import { superadminLogin } from "../services/superadmin.service.js";

const router = express.Router();

// Use env secret when available; fallback to a dev-safe secret.
// NOTE: for production always set process.env.JWT_SECRET to a secure random value.
const JWT_SECRET = process.env.JWT_SECRET || "task_management_secret_dev_fallback_please_change";

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });

    const result = await superadminLogin(email, password, { jwtSecret: JWT_SECRET });
    if (!result) return res.status(401).json({ error: "Invalid credentials" });

    res.json(result);
  } catch (err) {
    console.error("superadmin login error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
