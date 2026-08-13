import express from "express";
import {
  addAssuranceEvidence,
  completeAssuranceCommitment,
  createAssuranceCommitment,
  createAssuranceRecoveryTask,
  getAssuranceCommitmentDetail,
  getAssuranceOverview,
  updateAssuranceCommitment,
} from "../services/executionAssurance.service.js";

const router = express.Router();

function sendError(res, error, fallback) {
  const status = Number(error?.statusCode);
  const safeStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
  if (safeStatus >= 500) console.error(`${fallback}:`, error);
  return res.status(safeStatus).json({
    error: safeStatus >= 500 ? fallback : error.message,
    code: error?.code || "ASSURANCE_REQUEST_FAILED",
  });
}

router.get("/overview", async (req, res) => {
  try {
    const result = await getAssuranceOverview({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      role: req.user.role,
    });
    res.json(result);
  } catch (error) {
    sendError(res, error, "Failed to load execution assurance");
  }
});

router.post("/commitments", async (req, res) => {
  try {
    const commitment = await createAssuranceCommitment({
      workspaceId: req.workspaceId,
      actorId: req.user.id,
      role: req.user.role,
      input: req.body || {},
    });
    res.status(201).json({ commitment });
  } catch (error) {
    sendError(res, error, "Failed to create outcome");
  }
});

router.get("/commitments/:id", async (req, res) => {
  try {
    const detail = await getAssuranceCommitmentDetail({
      id: req.params.id,
      workspaceId: req.workspaceId,
      userId: req.user.id,
      role: req.user.role,
    });
    res.json(detail);
  } catch (error) {
    sendError(res, error, "Failed to load outcome");
  }
});

router.patch("/commitments/:id", async (req, res) => {
  try {
    const commitment = await updateAssuranceCommitment({
      id: req.params.id,
      workspaceId: req.workspaceId,
      actorId: req.user.id,
      role: req.user.role,
      input: req.body || {},
    });
    res.json({ commitment });
  } catch (error) {
    sendError(res, error, "Failed to update outcome");
  }
});

router.post("/commitments/:id/evidence", async (req, res) => {
  try {
    const evidence = await addAssuranceEvidence({
      id: req.params.id,
      workspaceId: req.workspaceId,
      actorId: req.user.id,
      role: req.user.role,
      input: req.body || {},
    });
    res.status(201).json({ evidence });
  } catch (error) {
    sendError(res, error, "Failed to record evidence");
  }
});

router.post("/commitments/:id/complete", async (req, res) => {
  try {
    const commitment = await completeAssuranceCommitment({
      id: req.params.id,
      workspaceId: req.workspaceId,
      actorId: req.user.id,
      role: req.user.role,
      input: req.body || {},
    });
    res.json({ commitment });
  } catch (error) {
    sendError(res, error, "Failed to complete outcome");
  }
});

router.post("/commitments/:id/recovery-task", async (req, res) => {
  try {
    const action = await createAssuranceRecoveryTask({
      id: req.params.id,
      workspaceId: req.workspaceId,
      actorId: req.user.id,
      role: req.user.role,
    });
    res.status(201).json({
      action,
      createdTaskId: action?.result?.createdTaskId || null,
      displayId: action?.result?.displayId || null,
    });
  } catch (error) {
    sendError(res, error, "Failed to create recovery task");
  }
});

export default router;
