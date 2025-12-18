import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "task_management_secret";
const WORKSPACE_GLOBAL = "GLOBAL";

export function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    if (!decoded || typeof decoded !== "object") {
      return res.status(401).json({ error: "Invalid token payload" });
    }

    // Normalize user id (backward compatible)
    const userId =
      decoded.id ||
      decoded.userId ||
      decoded.sub ||
      null;

    if (!userId) {
      return res.status(401).json({ error: "Invalid token: missing user id" });
    }

    // 🔐 STRICT workspace resolution
    let workspaceId =
      decoded.workspaceId ||
      req.headers["x-workspace-id"] ||
      null;

    // Normalize header casing
    if (Array.isArray(workspaceId)) {
      workspaceId = workspaceId[0];
    }

    // Superadmin is allowed GLOBAL
    const role = decoded.role || "user";
    if (role === "superadmin") {
      workspaceId = WORKSPACE_GLOBAL;
    }

    // 🔐 HARD BLOCK: normal users must have a resolved workspace
if (!workspaceId || workspaceId === WORKSPACE_GLOBAL) {
  if (role !== "superadmin") {
    return res.status(403).json({
      error: "Workspace not resolved for user",
    });
  }
}


    // Attach normalized user object
    req.user = {
      ...decoded,
      id: userId,
      role,
      workspaceId,
    };

    // Canonical workspace source
    req.workspaceId = workspaceId;

    next();
  } catch (err) {
    console.error("JWT verify error:", err.message);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}
