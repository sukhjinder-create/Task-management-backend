import express from "express";
import { superadminLogin } from "../services/superadmin.service.js";

const router = express.Router();

/**
 * Fixed & shared JWT secret for superadmin.
 * (Kept internal, not mixed with normal user auth)
 */
const FIXED_JWT_SECRET = "TASKMANAGEMENT_SUPERADMIN_SECRET_987654321";

/**
 * POST /superadmin/login
 * Superadmin authentication entrypoint
 */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const result = await superadminLogin(email, password, FIXED_JWT_SECRET);

    if (!result) {
      return res.status(401).json({ error: "Invalid superadmin credentials" });
    }

    /**
     * 🔥 IMPORTANT
     * Normalize response shape to what frontend expects
     */
    return res.json({
      token: result.token,
      superadmin: {
        id: result.user.id,
        email: result.user.email,
        role: "superadmin",
      },
    });
  } catch (err) {
    console.error("Superadmin login error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
