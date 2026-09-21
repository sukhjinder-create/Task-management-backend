// routes/aiStudioWorkspace.routes.js
//
// Epic C — Workspace AI Studio API. Workspace admins see/edit only what the lock
// model permits. Guarded by auth + workspace + admin role. Reuses the Studio
// services + governance. DB-backed override writes are schema-tolerant and
// UNVERIFIED AT RUNTIME.
//
// Mounted in index.js as:
//   app.use("/ai-studio", authMiddleware, requireWorkspaceForUser, allowRoles("admin"), aiStudioWorkspaceRoutes)

import express from "express";
import {
  getOverview, listCapabilityViewModels, getWorkspaceControls, computeEffectiveConfig,
  listProviderViewModels, listModelViewModels, listRuntimeProfileViewModels,
} from "../ai-platform/studio/aiStudioService.js";
import { can } from "../ai-platform/governance/permissions.js";
import { LOCK_LEVELS } from "../ai-platform/governance/locks.js";
import { upsertCapabilityConfig } from "../ai-platform/studio/configStore.service.js";
import { listProvidersMerged, listModelsMerged, listProfilesMerged } from "../ai-platform/studio/configReads.service.js";
import { listPrompts } from "../ai-platform/studio/promptRegistry.service.js";
import * as telemetry from "../ai-platform/studio/telemetry.service.js";
import { runPlayground } from "../ai-platform/studio/playground.service.js";
import pool from "../db.js";
import { logAudit } from "../services/audit.service.js";

const router = express.Router();
const wsRole = (req) => (req.user?.role === "admin" ? "workspace_admin" : "workspace_viewer");
const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(500).json({ error: e.message }); } };

// Option lists — workspace admins may only pick PROPERLY-CONFIGURED providers/models.
router.get("/providers", wrap(async (_req, res) => res.json((await listProvidersMerged()).filter((p) => p.enabled && p.configured))));
router.get("/models", wrap(async (_req, res) => {
  const ok = new Set((await listProvidersMerged()).filter((p) => p.enabled && p.configured).map((p) => p.key));
  res.json((await listModelsMerged()).filter((m) => m.enabled && ok.has(m.providerKey)));
}));
router.get("/profiles", wrap(async (_req, res) => res.json(await listProfilesMerged())));
router.get("/prompts", wrap(async (_req, res) => res.json(await listPrompts())));

router.get("/overview", (_req, res) => {
  const o = getOverview();
  res.json({ platform: { enabled: o.platform.enabled, contractVersion: o.platform.contractVersion }, counts: { capabilities: o.counts.capabilities } });
});

router.get("/capabilities", (_req, res) =>
  res.json(listCapabilityViewModels().map((c) => ({ key: c.key, name: c.name, category: c.category, description: c.description, lock: c.lock }))));

router.get("/capabilities/:key/controls", (req, res) => {
  const lock = LOCK_LEVELS.includes(req.query.lock) ? req.query.lock : "workspace_customizable";
  const controls = getWorkspaceControls({ role: wsRole(req), capabilityKey: req.params.key, lockLevel: lock });
  controls ? res.json(controls) : res.status(404).json({ error: "Unknown capability" });
});

// Preview an override (no persistence).
router.post("/capabilities/:key/preview-override", (req, res) => {
  const lock = LOCK_LEVELS.includes(req.body?.lock) ? req.body.lock : "workspace_customizable";
  const decision = can({ role: wsRole(req), verb: "override", objectType: "capability_config", scope: { workspaceId: req.workspaceId }, lockLevel: lock });
  if (!decision.allowed) return res.status(403).json({ error: "Override not permitted", reason: decision.reason });
  const cfg = computeEffectiveConfig({ capabilityKey: req.params.key, workspaceOverride: req.body?.override || {}, lockLevel: lock });
  cfg ? res.json({ allowed: true, preview: cfg }) : res.status(404).json({ error: "Unknown capability" });
});

// Persist a workspace override (permission + lock enforced; validated in the service).
router.put("/capabilities/:key/override", wrap(async (req, res) => {
  const lock = LOCK_LEVELS.includes(req.body?.lock) ? req.body.lock : "workspace_customizable";
  const decision = can({ role: wsRole(req), verb: "override", objectType: "capability_config", scope: { workspaceId: req.workspaceId }, lockLevel: lock });
  if (!decision.allowed) return res.status(403).json({ error: "Override not permitted", reason: decision.reason });
  const ov = req.body?.override || {};
  const r = await upsertCapabilityConfig({
    capabilityKey: req.params.key, scope: req.workspaceId, workspaceId: req.workspaceId,
    provider: ov.provider ?? null, model: ov.model ?? null, promptKey: ov.promptKey ?? null,
    runtimeProfile: ov.profile ?? null, actorId: req.user?.id,
  });
  r.ok ? res.json(r) : res.status(400).json(r);
}));

router.get("/usage", wrap(async (req, res) => res.json(await telemetry.getUsage({ workspaceId: req.workspaceId, period: req.query.period }))));
router.get("/cost", wrap(async (req, res) => res.json(await telemetry.getCost({ workspaceId: req.workspaceId, period: req.query.period }))));
router.post("/playground", wrap(async (req, res) => res.json(await runPlayground({ capability: req.body?.capability, prompt: req.body?.prompt, workspaceId: req.workspaceId, overrides: req.body?.overrides || {} }))));

const safetyDefaults = { enforcementMode: "off", piiRedaction: "off", outputSchemaMode: "advisory" };

router.get("/safety", wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT value_json FROM ai_policies
     WHERE scope='workspace' AND workspace_id=$1 AND key='safety' AND enabled=TRUE
     ORDER BY created_at DESC LIMIT 1`,
    [req.workspaceId]
  );
  res.json({ ...safetyDefaults, ...(rows[0]?.value_json || {}) });
}));

router.put("/safety", wrap(async (req, res) => {
  const value = {
    enforcementMode: String(req.body?.enforcementMode || "off"),
    piiRedaction: String(req.body?.piiRedaction || "off"),
    outputSchemaMode: String(req.body?.outputSchemaMode || "advisory"),
  };
  if (!["off", "variables", "strict"].includes(value.enforcementMode)) return res.status(400).json({ error: "Invalid enforcementMode" });
  if (!["off", "input", "output", "both"].includes(value.piiRedaction)) return res.status(400).json({ error: "Invalid piiRedaction" });
  if (!["advisory", "enforce"].includes(value.outputSchemaMode)) return res.status(400).json({ error: "Invalid outputSchemaMode" });
  const updated = await pool.query(
    `UPDATE ai_policies SET value_json=$1::jsonb, enabled=TRUE, created_by=$2
     WHERE scope='workspace' AND workspace_id=$3 AND key='safety' RETURNING id`,
    [JSON.stringify(value), req.user.id, req.workspaceId]
  );
  if (!updated.rowCount) {
    await pool.query(
      `INSERT INTO ai_policies (scope, workspace_id, key, value_json, enabled, created_by)
       VALUES ('workspace',$1,'safety',$2::jsonb,TRUE,$3)`,
      [req.workspaceId, JSON.stringify(value), req.user.id]
    );
  }
  await logAudit({ workspaceId: req.workspaceId, userId: req.user.id, action: "ai.safety_policy.update", entityType: "workspace", entityId: req.workspaceId, newValue: value });
  res.json(value);
}));

router.put("/capabilities/:key/output-schema", wrap(async (req, res) => {
  const schema = req.body?.schema;
  const mode = String(req.body?.mode || "advisory");
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return res.status(400).json({ error: "schema must be a JSON object" });
  if (!["advisory", "enforce"].includes(mode)) return res.status(400).json({ error: "mode must be advisory or enforce" });
  if (Buffer.byteLength(JSON.stringify(schema)) > 50_000) return res.status(400).json({ error: "schema is too large" });
  const value = { capability: req.params.key, schema, mode };
  const key = `output_schema:${req.params.key}`;
  const updated = await pool.query(
    `UPDATE ai_policies SET value_json=$1::jsonb, enabled=TRUE, created_by=$2
     WHERE scope='workspace' AND workspace_id=$3 AND key=$4 RETURNING id`,
    [JSON.stringify(value), req.user.id, req.workspaceId, key]
  );
  if (!updated.rowCount) {
    await pool.query(
      `INSERT INTO ai_policies (scope, workspace_id, key, value_json, enabled, created_by)
       VALUES ('workspace',$1,$2,$3::jsonb,TRUE,$4)`,
      [req.workspaceId, key, JSON.stringify(value), req.user.id]
    );
  }
  await logAudit({ workspaceId: req.workspaceId, userId: req.user.id, action: "ai.output_schema.update", entityType: "ai_capability", entityId: req.params.key, newValue: { mode } });
  res.json(value);
}));

export default router;
