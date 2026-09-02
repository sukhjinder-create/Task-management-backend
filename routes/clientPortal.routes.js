import express from "express";
import { clientPortalAccessLimiter } from "../middleware/rateLimit.middleware.js";
import {
  authenticatePortalSession,
  decideClientReview,
  exchangePortalMagicLink,
  listPortalCommitments,
  logoutPortalSession,
  requestPortalAccess,
} from "../services/clientPortal.service.js";

const router = express.Router();

function sendError(res, error, fallback) {
  const status = Number(error?.statusCode);
  const safeStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
  if (safeStatus >= 500) console.error(`${fallback}:`, error);
  return res.status(safeStatus).json({
    error: safeStatus >= 500 ? fallback : error.message,
    code: error?.code || "CLIENT_PORTAL_REQUEST_FAILED",
  });
}

function bearerToken(req) {
  const header = req.headers.authorization;
  return typeof header === "string" && header.startsWith("Bearer ")
    ? header.slice(7).trim()
    : "";
}

async function requireClientSession(req, res, next) {
  try {
    req.clientPortalToken = bearerToken(req);
    req.clientPortal = await authenticatePortalSession({ token: req.clientPortalToken });
    next();
  } catch (error) {
    sendError(res, error, "Client portal authentication failed");
  }
}

router.post("/auth/request", clientPortalAccessLimiter, async (req, res) => {
  try {
    await requestPortalAccess({
      email: req.body?.email,
      ipAddress: req.headers["cf-connecting-ip"] || req.ip,
      userAgent: req.headers["user-agent"] || null,
    });
    res.status(202).json({
      message: "If this client account exists, a secure access link has been sent.",
    });
  } catch (error) {
    sendError(res, error, "Could not request client portal access");
  }
});

router.post("/auth/exchange", async (req, res) => {
  try {
    res.json(await exchangePortalMagicLink({
      token: req.body?.token,
      ipAddress: req.headers["cf-connecting-ip"] || req.ip,
      userAgent: req.headers["user-agent"] || null,
    }));
  } catch (error) {
    sendError(res, error, "Could not open the secure client portal link");
  }
});

router.use(requireClientSession);

router.get("/me", (req, res) => {
  res.json({
    account: {
      contactName: req.clientPortal.contact_name,
      clientName: req.clientPortal.client_name,
      workspaceName: req.clientPortal.workspace_name,
      workspaceSlug: req.clientPortal.workspace_slug,
    },
    expiresAt: req.clientPortal.expires_at,
  });
});

router.get("/commitments", async (req, res) => {
  try {
    res.json(await listPortalCommitments({ session: req.clientPortal }));
  } catch (error) {
    sendError(res, error, "Could not load shared outcomes");
  }
});

router.post("/reviews/:id/decision", async (req, res) => {
  try {
    const review = await decideClientReview({
      reviewId: req.params.id,
      session: req.clientPortal,
      input: req.body || {},
      ipAddress: req.headers["cf-connecting-ip"] || req.ip,
      userAgent: req.headers["user-agent"] || null,
    });
    res.json({ review });
  } catch (error) {
    sendError(res, error, "Could not record the client decision");
  }
});

router.post("/auth/logout", async (req, res) => {
  try {
    await logoutPortalSession({
      token: req.clientPortalToken,
      session: req.clientPortal,
      ipAddress: req.headers["cf-connecting-ip"] || req.ip,
      userAgent: req.headers["user-agent"] || null,
    });
    res.status(204).end();
  } catch (error) {
    sendError(res, error, "Could not close the client portal session");
  }
});

export default router;
