import jwt from "jsonwebtoken";
import { attachOperationalEventCapture } from "../adaptive/events/operationalEvent.middleware.js";
import { getJwtSecret } from "../config/secrets.js";
import { getUserById } from "../repositories/user.repository.js";
import {
  apiKeyHasScope,
  authenticateApiKey,
  requiredScopeForRequest,
} from "../services/apiKey.service.js";
import { authenticateServiceAccountToken } from "../services/serviceAccount.service.js";

const JWT_SECRET = getJwtSecret();
const WORKSPACE_GLOBAL = "GLOBAL";

export async function authMiddleware(req, res, next) {
  if (req.method === "OPTIONS") {
    return next();
  }
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    if (/^(?:asy_|tm_)/i.test(token)) {
      const apiKey = await authenticateApiKey(token);
      if (!apiKey) return res.status(401).json({ error: "Invalid or expired API key" });

      const requiredScope = requiredScopeForRequest(req);
      if (!apiKeyHasScope(apiKey.scopes, requiredScope)) {
        return res.status(403).json({
          error: "API key does not have the required scope",
          required_scope: requiredScope,
        });
      }

      req.user = apiKey.user;
      req.workspaceId = apiKey.workspaceId;
      req.authType = "api_key";
      req.apiKey = { id: apiKey.id, scopes: apiKey.scopes };
      attachOperationalEventCapture(req, res);
      return next();
    }

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

    // Re-read the identity so a superadmin revocation takes effect immediately,
    // even for access tokens issued before verification was required.
    let currentUser;
    try {
      currentUser = await getUserById(userId);
    } catch (err) {
      console.error("Auth user validation error:", err.message);
      return res.status(503).json({ error: "Unable to validate session" });
    }

    if (decoded.token_use === "service_account") {
      const account = await authenticateServiceAccountToken(decoded, req);
      if (!account) return res.status(401).json({ error: "Invalid or expired service account token" });
      if (account.forbidden) {
        return res.status(403).json({
          error: "Service account does not have the required scope",
          required_scope: account.requiredScope,
        });
      }
      req.user = account.user;
      req.workspaceId = account.workspaceId;
      req.authType = "service_account";
      req.serviceAccount = { id: account.id, scopes: account.scopes };
      attachOperationalEventCapture(req, res);
      return next();
    }
    if (!currentUser) {
      return res.status(401).json({ error: "Invalid token: user not found" });
    }
    if (currentUser.disabled_at) {
      return res.status(401).json({ error: "Account is disabled" });
    }
    if (!currentUser.email_verified_at) {
      return res.status(401).json({
        error: "Verify your email before signing in.",
        code: "EMAIL_VERIFICATION_REQUIRED",
      });
    }

    // 🔐 STRICT workspace resolution
    let workspaceId =
      currentUser.workspace_id ||
      decoded.workspaceId ||
      req.headers["x-workspace-id"] ||
      null;

    // Normalize header casing
    if (Array.isArray(workspaceId)) {
      workspaceId = workspaceId[0];
    }

    // Superadmin is allowed GLOBAL
    const role = currentUser.role || "user";
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
      username: currentUser.username,
      email: currentUser.email,
      role,
      workspaceId,
    };

    // Canonical workspace source
    req.workspaceId = workspaceId;

    attachOperationalEventCapture(req, res);

    next();
  } catch (err) {
    console.error("JWT verify error:", err.message);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}
