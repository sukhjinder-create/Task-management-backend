import express from "express";
import {
  getIntegrationWebhookStatus,
  handleAsanaWebhookEvent,
  handleYouTrackWebhookEvent,
  recordAsanaHandshakeSecret,
  resolveIntegrationWebhookBaseUrl,
  setupAsanaWebhooks,
  setupYouTrackWebhook,
} from "./integration.webhook.service.js";

export const integrationWebhookSetupRoutes = express.Router();
export const integrationWebhookReceiverRoutes = express.Router();

function readBoolean(value) {
  return value === true || value === "true" || value === "1";
}

function handleWebhookError(res, err) {
  const status = err.statusCode || err.status || 500;

  if (status >= 500) {
    console.error("[integration-webhook] error:", err.message);
  }

  res.status(status).json({
    error: err.message || "Webhook processing failed",
  });
}

integrationWebhookSetupRoutes.get("/status", async (req, res) => {
  try {
    const publicBaseUrl = resolveIntegrationWebhookBaseUrl(req);
    const status = await getIntegrationWebhookStatus({
      workspaceId: req.workspaceId,
      publicBaseUrl,
    });

    res.json(status);
  } catch (err) {
    handleWebhookError(res, err);
  }
});

integrationWebhookSetupRoutes.get("/:provider/status", async (req, res) => {
  try {
    const publicBaseUrl = resolveIntegrationWebhookBaseUrl(req);
    const status = await getIntegrationWebhookStatus({
      workspaceId: req.workspaceId,
      publicBaseUrl,
      provider: req.params.provider,
    });

    res.json(status);
  } catch (err) {
    handleWebhookError(res, err);
  }
});

integrationWebhookSetupRoutes.post("/asana/setup", async (req, res) => {
  try {
    const publicBaseUrl = resolveIntegrationWebhookBaseUrl(req);
    const result = await setupAsanaWebhooks({
      workspaceId: req.workspaceId,
      publicBaseUrl,
      force: readBoolean(req.body?.force),
    });

    res.json(result);
  } catch (err) {
    handleWebhookError(res, err);
  }
});

integrationWebhookSetupRoutes.post("/youtrack/setup", async (req, res) => {
  try {
    const publicBaseUrl = resolveIntegrationWebhookBaseUrl(req);
    const result = await setupYouTrackWebhook({
      workspaceId: req.workspaceId,
      publicBaseUrl,
      rotate: readBoolean(req.body?.rotate),
      headerName: req.body?.headerName,
    });

    res.json(result);
  } catch (err) {
    handleWebhookError(res, err);
  }
});

integrationWebhookReceiverRoutes.post(
  "/asana/:workspaceId/:resourceGid/:nonce",
  async (req, res) => {
    try {
      const { workspaceId, resourceGid, nonce } = req.params;
      const handshakeSecret = req.headers["x-hook-secret"];

      if (handshakeSecret) {
        await recordAsanaHandshakeSecret({
          workspaceId,
          resourceGid,
          nonce,
          secret: handshakeSecret,
        });

        res.set("X-Hook-Secret", handshakeSecret);
        return res.status(200).send("");
      }

      const result = await handleAsanaWebhookEvent({
        workspaceId,
        resourceGid,
        nonce,
        rawBody: req.rawBody || Buffer.from(JSON.stringify(req.body || {})),
        body: req.body,
        headers: req.headers,
      });

      res.status(202).json(result);
    } catch (err) {
      handleWebhookError(res, err);
    }
  }
);

integrationWebhookReceiverRoutes.post("/youtrack/:workspaceId", async (req, res) => {
  try {
    const result = await handleYouTrackWebhookEvent({
      workspaceId: req.params.workspaceId,
      body: req.body,
      headers: req.headers,
    });

    res.status(202).json(result);
  } catch (err) {
    handleWebhookError(res, err);
  }
});
