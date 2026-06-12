import express from "express";
import {
  addArtifactSources,
  approveHuddleArtifact,
  createHuddleArtifact,
  getHuddleArtifact,
  getHuddleArtifactDiagnostics,
  grantArtifactPermission,
  listArtifactPermissions,
  listArtifactRevisions,
  listArtifactSources,
  listHuddleArtifacts,
  rejectHuddleArtifact,
  revokeHuddleArtifact,
  updateHuddleArtifact,
} from "../services/huddleArtifact.service.js";

const router = express.Router();

function actor(req) {
  return {
    actorUserId: req.user?.id,
    role: req.user?.role || "user",
  };
}

function errorResponse(res, error) {
  const status = error?.statusCode || 500;
  const reason = error?.reason || error?.message || "huddle_artifact_error";
  if (status >= 500) {
    console.error("[huddle:artifact]", error);
  }
  return res.status(status).json({ ok: false, reason });
}

router.get("/diagnostics", (_req, res) => {
  res.json({
    ok: true,
    artifacts: getHuddleArtifactDiagnostics(),
  });
});

router.get("/sessions/:sessionId", async (req, res) => {
  try {
    const artifacts = await listHuddleArtifacts({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      ...actor(req),
      artifactType: req.query.artifactType || req.query.type,
      status: req.query.status,
      approvalStatus: req.query.approvalStatus,
      includeDeleted: req.query.includeDeleted === "true",
      limit: req.query.limit,
    });
    res.json({ ok: true, artifacts });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/sessions/:sessionId", async (req, res) => {
  try {
    const result = await createHuddleArtifact({
      workspaceId: req.workspaceId,
      sessionId: req.params.sessionId,
      ...actor(req),
      input: req.body || {},
    });
    res.status(201).json({ ok: true, ...result });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get("/:artifactId/revisions", async (req, res) => {
  try {
    const revisions = await listArtifactRevisions({
      workspaceId: req.workspaceId,
      artifactId: req.params.artifactId,
      ...actor(req),
    });
    res.json({ ok: true, revisions });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get("/:artifactId/sources", async (req, res) => {
  try {
    const sources = await listArtifactSources({
      workspaceId: req.workspaceId,
      artifactId: req.params.artifactId,
      ...actor(req),
    });
    res.json({ ok: true, sources });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/:artifactId/sources", async (req, res) => {
  try {
    const result = await addArtifactSources({
      workspaceId: req.workspaceId,
      artifactId: req.params.artifactId,
      ...actor(req),
      sources: req.body?.sources || [req.body],
    });
    res.status(201).json({ ok: true, ...result });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get("/:artifactId/permissions", async (req, res) => {
  try {
    const permissions = await listArtifactPermissions({
      workspaceId: req.workspaceId,
      artifactId: req.params.artifactId,
      ...actor(req),
    });
    res.json({ ok: true, permissions });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/:artifactId/permissions", async (req, res) => {
  try {
    const result = await grantArtifactPermission({
      workspaceId: req.workspaceId,
      artifactId: req.params.artifactId,
      ...actor(req),
      input: req.body || {},
    });
    res.status(201).json({ ok: true, ...result });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/:artifactId/approve", async (req, res) => {
  try {
    const result = await approveHuddleArtifact({
      workspaceId: req.workspaceId,
      artifactId: req.params.artifactId,
      ...actor(req),
      approvalNote: req.body?.approvalNote || req.body?.note,
      expectedRevision: req.body?.expectedRevision,
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/:artifactId/reject", async (req, res) => {
  try {
    const result = await rejectHuddleArtifact({
      workspaceId: req.workspaceId,
      artifactId: req.params.artifactId,
      ...actor(req),
      approvalNote: req.body?.approvalNote || req.body?.note,
      expectedRevision: req.body?.expectedRevision,
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/:artifactId/revoke", async (req, res) => {
  try {
    const result = await revokeHuddleArtifact({
      workspaceId: req.workspaceId,
      artifactId: req.params.artifactId,
      ...actor(req),
      approvalNote: req.body?.approvalNote || req.body?.note,
      expectedRevision: req.body?.expectedRevision,
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get("/:artifactId", async (req, res) => {
  try {
    const artifact = await getHuddleArtifact({
      workspaceId: req.workspaceId,
      artifactId: req.params.artifactId,
      ...actor(req),
    });
    res.json({ ok: true, artifact });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.patch("/:artifactId", async (req, res) => {
  try {
    const result = await updateHuddleArtifact({
      workspaceId: req.workspaceId,
      artifactId: req.params.artifactId,
      ...actor(req),
      patch: req.body || {},
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    errorResponse(res, error);
  }
});

export default router;
