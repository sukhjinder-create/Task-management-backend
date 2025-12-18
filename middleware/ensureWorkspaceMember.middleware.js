// middleware/ensureWorkspaceMember.middleware.js
import { getWorkspaceUser } from "../repositories/workspace.repository.js";

/**
 * Ensure req.workspaceId exists and req.user is member of that workspace.
 * Assumes authMiddleware ran before (so req.user exists).
 *
 * Options:
 *   - allowAdmins: if true, workspace admins pass (default true)
 */
export function ensureWorkspaceMember({ allowAdmins = true } = {}) {
  return async function (req, res, next) {
    try {
      const workspaceId = req.workspaceId;
      const user = req.user;

      if (!workspaceId) {
        // no workspace scoping required; allow
        return next();
      }

      if (!user || !user.id) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const record = await getWorkspaceUser(workspaceId, String(user.id));
      if (!record) {
        return res.status(403).json({ error: "You are not a member of this workspace" });
      }

      if (!allowAdmins) {
        // any member is OK
        return next();
      }

      // attach workspace role info to req for downstream use
      req.workspaceRole = record.role || "member";
      return next();
    } catch (err) {
      console.error("[ensureWorkspaceMember] error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  };
}
