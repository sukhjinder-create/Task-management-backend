// middleware/workspace.middleware.js

/**
 * Enforces workspace isolation for normal users.
 * Assumes:
 *  - authMiddleware has already populated req.user
 *  - each user belongs to exactly ONE workspace
 *
 * This middleware:
 *  - sets req.workspaceId
 *  - attaches req.workspace
 *  - blocks requests if workspace is missing or inactive
 *
 * Superadmins are NOT allowed through this middleware.
 */

import { getWorkspaceById } from "../repositories/workspace.repository.js";

export async function requireWorkspaceForUser(req, res, next) {
  // authMiddleware must run first
  if (!req.user) {
    return res.status(401).json({ error: "Unauthenticated" });
  }

  // Superadmin must never use tenant routes
  if (
    String(req.user.role || "").toLowerCase() === "superadmin"
  ) {
    return res
      .status(403)
      .json({ error: "Superadmin cannot access workspace routes" });
  }

  const workspaceId =
    req.user.workspace_id ||
    req.user.workspaceId || // fallback for older payloads
    null;

  if (!workspaceId) {
    return res.status(400).json({
      error: "Workspace not assigned to user",
    });
  }

  // 🔐 Attach ID immediately (used by logging / tracing)
  req.workspaceId = workspaceId;

  // 🔎 Load workspace from DB
  let workspace;
  try {
    workspace = await getWorkspaceById(workspaceId);
  } catch (err) {
    console.error("Workspace lookup failed:", err);
    return res
      .status(500)
      .json({ error: "Failed to verify workspace" });
  }

  if (!workspace) {
    return res.status(404).json({
      error: "Workspace not found",
    });
  }

  // 🚫 Enforce workspace status
  if (workspace.status && workspace.status !== "active") {
    return res.status(403).json({
      error: `Workspace is ${workspace.status}`,
    });
  }

  // 🔐 Attach full workspace for downstream use
  req.workspace = workspace;

  next();
}
