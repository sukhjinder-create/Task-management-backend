import jwt from "jsonwebtoken";

// Fixed secret for superadmin (intentionally separate from normal users)
const FIXED_JWT_SECRET = "TASKMANAGEMENT_SUPERADMIN_SECRET_987654321";

export default function requireSuperadmin(req, res, next) {
  const auth = req.headers.authorization;

  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing superadmin token" });
  }

  const token = auth.split(" ")[1];

  try {
    const decoded = jwt.verify(token, FIXED_JWT_SECRET);

    if (!decoded || typeof decoded !== "object") {
      return res.status(401).json({ error: "Invalid superadmin token payload" });
    }

    // Normalize role check (defensive)
    if (decoded.role !== "superadmin") {
      return res.status(403).json({ error: "Forbidden" });
    }

    // Normalize superadmin id (supports future extension)
    const superadminId =
      decoded.id ||
      decoded.superadminId ||
      decoded.sub ||
      null;

    if (!superadminId) {
      return res
        .status(401)
        .json({ error: "Invalid superadmin token: missing id" });
    }

    // Attach superadmin context
    req.superadmin = {
      ...decoded,
      id: superadminId,
      role: "superadmin",
    };

    next();
  } catch (err) {
    console.error("Superadmin JWT verify error:", err.message);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}
