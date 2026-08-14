import express from "express";
import { allowRoles } from "../middleware/role.middleware.js";
import {
  addAssuranceEvidence,
  completeAssuranceCommitment,
  createAssuranceCommitment,
  createAssuranceRecoveryTask,
  getAssuranceCommitmentDetail,
  getAssuranceOverview,
  updateAssuranceCommitment,
} from "../services/executionAssurance.service.js";
import {
  assertAssuranceApprover,
  assertAssuranceEvidenceWriter,
  createAssuranceDependency,
  createAssurancePortfolio,
  decideAssuranceApproval,
  deleteAssuranceDependency,
  generateAssuranceExport,
  getAssuranceInbox,
  getAssurancePolicy,
  getAssurancePortfolio,
  getExecutiveAssuranceReport,
  requestAssuranceApproval,
  setPortfolioCommitment,
  updateAssurancePolicy,
  updateAssurancePortfolio,
} from "../services/enterpriseAssurance.service.js";
import {
  analyzeAssuranceScenario,
  createAssuranceDecision,
  createAssuranceExperiment,
  generateOutcomeReceipt,
  getDecisionLab,
  getDecisionOperatingInbox,
  getDecisionOutcomeRecord,
  getOutcomeReceipt,
  listAdaptivePolicyProposals,
  refreshAdaptivePolicyProposals,
  reviewAdaptivePolicyProposal,
  reviewAssuranceDecision,
  updateAssuranceExperiment,
} from "../services/decisionOutcome.service.js";

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
    const policy = await getAssurancePolicy(req.workspaceId);
    const result = await getAssuranceOverview({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      role: req.user.role,
      policy,
    });
    res.json(result);
  } catch (error) {
    sendError(res, error, "Failed to load execution assurance");
  }
});

router.post("/commitments", allowRoles("manager", "admin"), async (req, res) => {
  try {
    const policy = await getAssurancePolicy(req.workspaceId);
    const commitment = await createAssuranceCommitment({
      workspaceId: req.workspaceId,
      actorId: req.user.id,
      role: req.user.role,
      input: req.body || {},
      policy,
    });
    res.status(201).json({ commitment });
  } catch (error) {
    sendError(res, error, "Failed to create outcome");
  }
});

router.get("/commitments/:id", async (req, res) => {
  try {
    const policy = await getAssurancePolicy(req.workspaceId);
    const detail = await getAssuranceCommitmentDetail({
      id: req.params.id,
      workspaceId: req.workspaceId,
      userId: req.user.id,
      role: req.user.role,
      policy,
    });
    res.json(detail);
  } catch (error) {
    sendError(res, error, "Failed to load outcome");
  }
});

router.patch("/commitments/:id", allowRoles("manager", "admin"), async (req, res) => {
  try {
    const policy = await getAssurancePolicy(req.workspaceId);
    const commitment = await updateAssuranceCommitment({
      id: req.params.id,
      workspaceId: req.workspaceId,
      actorId: req.user.id,
      role: req.user.role,
      input: req.body || {},
      policy,
    });
    res.json({ commitment });
  } catch (error) {
    sendError(res, error, "Failed to update outcome");
  }
});

router.post("/commitments/:id/evidence", async (req, res) => {
  try {
    const policy = await assertAssuranceEvidenceWriter({ workspaceId: req.workspaceId, role: req.user.role });
    const evidence = await addAssuranceEvidence({
      id: req.params.id,
      workspaceId: req.workspaceId,
      actorId: req.user.id,
      role: req.user.role,
      input: req.body || {},
      policy,
    });
    res.status(201).json({ evidence });
  } catch (error) {
    sendError(res, error, "Failed to record evidence");
  }
});

router.post("/commitments/:id/complete", allowRoles("manager", "admin"), async (req, res) => {
  try {
    const policy = await assertAssuranceApprover({ workspaceId: req.workspaceId, role: req.user.role, action: "complete" });
    const commitment = await completeAssuranceCommitment({
      id: req.params.id,
      workspaceId: req.workspaceId,
      actorId: req.user.id,
      role: req.user.role,
      input: req.body || {},
      policy,
      requireResultEvidence: policy.requireResultEvidence,
    });
    res.json({ commitment });
  } catch (error) {
    sendError(res, error, "Failed to complete outcome");
  }
});

router.post("/commitments/:id/recovery-task", allowRoles("manager", "admin"), async (req, res) => {
  try {
    const policy = await assertAssuranceApprover({ workspaceId: req.workspaceId, role: req.user.role, action: "recovery" });
    const action = await createAssuranceRecoveryTask({
      id: req.params.id,
      workspaceId: req.workspaceId,
      actorId: req.user.id,
      role: req.user.role,
      policy,
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

router.get("/policy", allowRoles("admin"), async (req, res) => {
  try {
    res.json({ policy: await getAssurancePolicy(req.workspaceId) });
  } catch (error) {
    sendError(res, error, "Failed to load assurance policy");
  }
});

router.put("/policy", allowRoles("admin"), async (req, res) => {
  try {
    const policy = await updateAssurancePolicy({
      workspaceId: req.workspaceId,
      actorId: req.user.id,
      role: req.user.role,
      input: req.body || {},
    });
    res.json({ policy });
  } catch (error) {
    sendError(res, error, "Failed to update assurance policy");
  }
});

router.get("/portfolio", allowRoles("manager", "admin"), async (req, res) => {
  try {
    res.json(await getAssurancePortfolio({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      role: req.user.role,
    }));
  } catch (error) {
    sendError(res, error, "Failed to load assurance portfolio");
  }
});

router.post("/portfolios", allowRoles("manager", "admin"), async (req, res) => {
  try {
    const portfolio = await createAssurancePortfolio({
      workspaceId: req.workspaceId,
      actorId: req.user.id,
      role: req.user.role,
      input: req.body || {},
    });
    res.status(201).json({ portfolio });
  } catch (error) {
    sendError(res, error, "Failed to create portfolio");
  }
});

router.patch("/portfolios/:id", allowRoles("manager", "admin"), async (req, res) => {
  try {
    const portfolio = await updateAssurancePortfolio({
      id: req.params.id,
      workspaceId: req.workspaceId,
      actorId: req.user.id,
      role: req.user.role,
      input: req.body || {},
    });
    res.json({ portfolio });
  } catch (error) {
    sendError(res, error, "Failed to update portfolio");
  }
});

router.put("/portfolios/:id/commitments/:goalId", allowRoles("manager", "admin"), async (req, res) => {
  try {
    res.json(await setPortfolioCommitment({
      portfolioId: req.params.id,
      goalId: req.params.goalId,
      workspaceId: req.workspaceId,
      actorId: req.user.id,
      role: req.user.role,
      linked: true,
    }));
  } catch (error) {
    sendError(res, error, "Failed to add outcome to portfolio");
  }
});

router.delete("/portfolios/:id/commitments/:goalId", allowRoles("manager", "admin"), async (req, res) => {
  try {
    res.json(await setPortfolioCommitment({
      portfolioId: req.params.id,
      goalId: req.params.goalId,
      workspaceId: req.workspaceId,
      actorId: req.user.id,
      role: req.user.role,
      linked: false,
    }));
  } catch (error) {
    sendError(res, error, "Failed to remove outcome from portfolio");
  }
});

router.post("/dependencies", allowRoles("manager", "admin"), async (req, res) => {
  try {
    const dependency = await createAssuranceDependency({
      workspaceId: req.workspaceId,
      actorId: req.user.id,
      role: req.user.role,
      input: req.body || {},
    });
    res.status(201).json({ dependency });
  } catch (error) {
    sendError(res, error, "Failed to create dependency");
  }
});

router.delete("/dependencies/:id", allowRoles("manager", "admin"), async (req, res) => {
  try {
    res.json(await deleteAssuranceDependency({
      id: req.params.id,
      workspaceId: req.workspaceId,
      actorId: req.user.id,
      role: req.user.role,
    }));
  } catch (error) {
    sendError(res, error, "Failed to remove dependency");
  }
});

router.get("/inbox", async (req, res) => {
  try {
    const [base, operating] = await Promise.all([
      getAssuranceInbox({
        workspaceId: req.workspaceId,
        userId: req.user.id,
        role: req.user.role,
      }),
      getDecisionOperatingInbox({
        workspaceId: req.workspaceId,
        userId: req.user.id,
        role: req.user.role,
      }),
    ]);
    const decisionReviews = operating.decisionsNeedingReview?.length || 0;
    const experiments = operating.experimentsNeedingAttention?.length || 0;
    res.json({
      ...base,
      ...operating,
      summary: {
        ...base.summary,
        decisionReviews,
        experiments,
        total: Number(base.summary?.total || 0) + decisionReviews + experiments,
      },
    });
  } catch (error) {
    sendError(res, error, "Failed to load assurance inbox");
  }
});

router.get("/commitments/:id/operating-record", async (req, res) => {
  try {
    res.json(await getDecisionOutcomeRecord({
      workspaceId: req.workspaceId,
      goalId: req.params.id,
      actorId: req.user.id,
      role: req.user.role,
    }));
  } catch (error) {
    sendError(res, error, "Failed to load the decision-to-outcome record");
  }
});

router.get("/commitments/:id/decision-lab", allowRoles("manager", "admin"), async (req, res) => {
  try {
    res.json(await getDecisionLab({
      workspaceId: req.workspaceId,
      goalId: req.params.id,
      actorId: req.user.id,
      role: req.user.role,
    }));
  } catch (error) {
    sendError(res, error, "Failed to load decision guidance");
  }
});

router.post("/commitments/:id/decisions", allowRoles("manager", "admin"), async (req, res) => {
  try {
    const decision = await createAssuranceDecision({
      workspaceId: req.workspaceId,
      goalId: req.params.id,
      actorId: req.user.id,
      role: req.user.role,
      input: req.body || {},
    });
    res.status(201).json({ decision });
  } catch (error) {
    sendError(res, error, "Failed to record the decision");
  }
});

router.post("/decisions/:id/reviews", allowRoles("manager", "admin"), async (req, res) => {
  try {
    const review = await reviewAssuranceDecision({
      id: req.params.id,
      workspaceId: req.workspaceId,
      actorId: req.user.id,
      role: req.user.role,
      input: req.body || {},
    });
    res.status(201).json({ review });
  } catch (error) {
    sendError(res, error, "Failed to review the decision result");
  }
});

router.post("/commitments/:id/experiments", allowRoles("manager", "admin"), async (req, res) => {
  try {
    const experiment = await createAssuranceExperiment({
      workspaceId: req.workspaceId,
      goalId: req.params.id,
      actorId: req.user.id,
      role: req.user.role,
      input: req.body || {},
    });
    res.status(201).json({ experiment });
  } catch (error) {
    sendError(res, error, "Failed to create the reversible experiment");
  }
});

router.patch("/experiments/:id", async (req, res) => {
  try {
    const experiment = await updateAssuranceExperiment({
      id: req.params.id,
      workspaceId: req.workspaceId,
      actorId: req.user.id,
      role: req.user.role,
      input: req.body || {},
    });
    res.json({ experiment });
  } catch (error) {
    sendError(res, error, "Failed to update the experiment");
  }
});

router.post("/commitments/:id/scenarios", allowRoles("manager", "admin"), async (req, res) => {
  try {
    const scenario = await analyzeAssuranceScenario({
      workspaceId: req.workspaceId,
      goalId: req.params.id,
      actorId: req.user.id,
      role: req.user.role,
      input: req.body || {},
    });
    res.status(201).json({ scenario });
  } catch (error) {
    sendError(res, error, "Failed to compare the scenario");
  }
});

router.post("/commitments/:id/receipts", allowRoles("manager", "admin"), async (req, res) => {
  try {
    const receipt = await generateOutcomeReceipt({
      workspaceId: req.workspaceId,
      goalId: req.params.id,
      actorId: req.user.id,
      role: req.user.role,
      input: req.body || {},
    });
    res.status(201).json({ receipt });
  } catch (error) {
    sendError(res, error, "Failed to generate the outcome receipt");
  }
});

router.get("/receipts/:id", allowRoles("manager", "admin"), async (req, res) => {
  try {
    const result = await getOutcomeReceipt({
      id: req.params.id,
      workspaceId: req.workspaceId,
      actorId: req.user.id,
      role: req.user.role,
    });
    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
    res.setHeader("X-Outcome-Receipt-Sha256", result.receipt.sha256);
    res.send(result.content);
  } catch (error) {
    sendError(res, error, "Failed to download the outcome receipt");
  }
});

router.get("/adaptive-policy-proposals", allowRoles("admin"), async (req, res) => {
  try {
    res.json(await listAdaptivePolicyProposals({
      workspaceId: req.workspaceId,
      role: req.user.role,
    }));
  } catch (error) {
    sendError(res, error, "Failed to load adaptive policy proposals");
  }
});

router.post("/adaptive-policy-proposals/refresh", allowRoles("admin"), async (req, res) => {
  try {
    res.json(await refreshAdaptivePolicyProposals({
      workspaceId: req.workspaceId,
      actorId: req.user.id,
      role: req.user.role,
    }));
  } catch (error) {
    sendError(res, error, "Failed to refresh adaptive policy proposals");
  }
});

router.post("/adaptive-policy-proposals/:id/decision", allowRoles("admin"), async (req, res) => {
  try {
    res.json(await reviewAdaptivePolicyProposal({
      id: req.params.id,
      workspaceId: req.workspaceId,
      actorId: req.user.id,
      role: req.user.role,
      input: req.body || {},
    }));
  } catch (error) {
    sendError(res, error, "Failed to review the adaptive policy proposal");
  }
});

router.post("/commitments/:id/approval-requests", async (req, res) => {
  try {
    const approval = await requestAssuranceApproval({
      goalId: req.params.id,
      workspaceId: req.workspaceId,
      actorId: req.user.id,
      role: req.user.role,
      input: req.body || {},
    });
    res.status(201).json({ approval });
  } catch (error) {
    sendError(res, error, "Failed to request assurance approval");
  }
});

router.post("/approval-requests/:id/decision", allowRoles("manager", "admin"), async (req, res) => {
  try {
    res.json(await decideAssuranceApproval({
      id: req.params.id,
      workspaceId: req.workspaceId,
      actorId: req.user.id,
      role: req.user.role,
      input: req.body || {},
    }));
  } catch (error) {
    sendError(res, error, "Failed to decide assurance request");
  }
});

router.get("/executive-report", allowRoles("manager", "admin"), async (req, res) => {
  try {
    res.json(await getExecutiveAssuranceReport({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      role: req.user.role,
    }));
  } catch (error) {
    sendError(res, error, "Failed to load executive assurance report");
  }
});

router.get("/export", allowRoles("manager", "admin"), async (req, res) => {
  try {
    const result = await generateAssuranceExport({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      role: req.user.role,
      format: req.query.format || "json",
    });
    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
    res.setHeader("X-Assurance-Export-Id", result.exportId);
    res.setHeader("X-Assurance-Export-Sha256", result.sha256);
    res.send(result.content);
  } catch (error) {
    sendError(res, error, "Failed to generate assurance export");
  }
});

export default router;
