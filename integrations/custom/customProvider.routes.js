// integrations/custom/customProvider.routes.js
//
// Admin API for defining integrations in the UI. Mounted behind the same
// auth + workspace + admin-role stack as the rest of /integrations.

import express from "express";
import pool from "../../db.js";
import {
  listCustomProviders,
  saveCustomProvider,
  deleteCustomProvider,
  testCustomProvider,
  listCustomProviderProjects,
  migrateCustomProvider,
  generateWebhookSecret,
} from "./customProvider.service.js";
import { customProviderKey } from "../core/providerCapabilities.js";

const router = express.Router();

router.get("/custom-providers", async (req, res) => {
  try {
    res.json({ providers: await listCustomProviders(req.workspaceId) });
  } catch (err) {
    console.error("Failed to list custom providers:", err);
    res.status(500).json({ error: "Failed to load platforms" });
  }
});

router.post("/custom-providers", async (req, res) => {
  try {
    const provider = await saveCustomProvider({
      workspaceId: req.workspaceId,
      actorUserId: req.user?.id,
      payload: req.body || {},
    });
    res.status(201).json({ provider });
  } catch (err) {
    // These are admin input errors — surface the message so the UI can show it.
    res.status(400).json({ error: err.message });
  }
});

router.put("/custom-providers/:slug", async (req, res) => {
  try {
    const provider = await saveCustomProvider({
      workspaceId: req.workspaceId,
      actorUserId: req.user?.id,
      slug: req.params.slug,
      payload: req.body || {},
    });
    res.json({ provider });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/custom-providers/:slug", async (req, res) => {
  try {
    await deleteCustomProvider(req.workspaceId, req.params.slug);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Verify credentials and return a real sample record plus its field paths, so
 * the admin maps against what their API actually returns.
 */
router.post("/custom-providers/:slug/test", async (req, res) => {
  try {
    const result = await testCustomProvider({
      workspaceId: req.workspaceId,
      slug: req.params.slug,
      probePath: req.body?.probePath || null,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/custom-providers/:slug/projects", async (req, res) => {
  try {
    res.json({ projects: await listCustomProviderProjects({
      workspaceId: req.workspaceId,
      slug: req.params.slug,
    }) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/custom-providers/:slug/migrate", async (req, res) => {
  try {
    const result = await migrateCustomProvider({
      workspaceId: req.workspaceId,
      slug: req.params.slug,
      projectId: req.body?.projectId || null,
      mode: req.body?.mode === "replace" ? "replace" : "skip",
      triggeredBy: req.user?.id,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Issue (or rotate) an inbound webhook endpoint so a custom platform can push
 * changes in real time instead of waiting for the reconciliation sweep.
 */
router.post("/custom-providers/:slug/webhook", async (req, res) => {
  try {
    const provider = customProviderKey(req.params.slug);
    const secret = generateWebhookSecret();
    const externalProjectId = req.body?.externalProjectId || null;
    const signatureHeader = req.body?.signatureHeader || "x-asystence-token";
    const entityIdPath = req.body?.entityIdPath || null;

    const { rows } = await pool.query(
      `
      INSERT INTO integration_webhook_endpoints
        (workspace_id, provider, external_project_id, secret, signature_header, entity_id_path)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (workspace_id, provider, COALESCE(external_project_id, ''))
      DO UPDATE SET secret = EXCLUDED.secret,
                    signature_header = EXCLUDED.signature_header,
                    entity_id_path = EXCLUDED.entity_id_path,
                    active = true,
                    updated_at = NOW()
      RETURNING *
      `,
      [req.workspaceId, provider, externalProjectId, secret, signatureHeader, entityIdPath]
    );

    const baseUrl = process.env.INTEGRATION_WEBHOOK_BASE_URL
      || process.env.PUBLIC_API_BASE_URL
      || `${req.protocol}://${req.get("host")}`;

    res.json({
      endpoint: {
        id: rows[0].id,
        // Shown once, at creation time — the admin pastes these into their tool.
        url: `${String(baseUrl).replace(/\/+$/, "")}/integration-webhooks/custom/${req.workspaceId}/${req.params.slug}`,
        headerName: rows[0].signature_header,
        secret,
        externalProjectId: rows[0].external_project_id,
      },
    });
  } catch (err) {
    console.error("Failed to create webhook endpoint:", err);
    res.status(400).json({ error: err.message });
  }
});

export default router;
