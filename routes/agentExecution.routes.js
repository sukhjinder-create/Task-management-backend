// routes/agentExecution.routes.js
//
// The narrow internal door the AI agent uses to PROPOSE actions and to relay a
// human's approve/reject click from chat.
//
// Deliberately NOT the /superadmin/execution admin surface. That surface was
// moved to superadmin ownership on purpose (see index.js), and this does not
// reopen it: there are three endpoints, no listing, no policy editing, no
// capability execution by key. A workspace manager can approve the one decision
// the agent showed them, in chat, and nothing else.
//
// Guarded by the internal service secret (only the AI service can reach it).
// The ACTING USER is passed through explicitly and their authority is verified
// inside execution/agentBridge.js against the approval chain — the agent relays
// the click, it never decides whether the click counts.

import express from "express";
import { requireInternalServiceSecret } from "../config/secrets.js";
import { proposeAgentAction, decideAgentApproval } from "../execution/agentBridge.js";
import { isExecutionEnabled } from "../execution/config.js";
import * as store from "../execution/stores.js";

const router = express.Router();

/** Is the governed path available for this workspace? Lets the agent choose its route. */
router.get("/agent/execution/status", requireInternalServiceSecret, (req, res) => {
  const workspaceId = req.query?.workspaceId || null;
  res.json({ enabled: isExecutionEnabled(workspaceId), workspaceId });
});

/** Propose an action. Returns either an outcome, or a question to ask the user. */
router.post("/agent/execution/propose", requireInternalServiceSecret, async (req, res) => {
  try {
    const { workspaceId, capabilityKey, slots, trigger } = req.body || {};
    if (!workspaceId || !capabilityKey) {
      return res.status(400).json({ error: "workspaceId and capabilityKey are required" });
    }
    const outcome = await proposeAgentAction({ workspaceId, capabilityKey, slots: slots || {}, trigger: trigger || {} });
    return res.json(outcome);
  } catch (err) {
    console.error("[agent-execution] propose failed:", err);
    return res.status(500).json({ error: "agent_propose_failed", detail: err.message });
  }
});

/** Relay an approve/reject a human made in chat. Authority is checked in the bridge. */
router.post("/agent/execution/decide", requireInternalServiceSecret, async (req, res) => {
  try {
    const { workspaceId, decisionId, action, actor } = req.body || {};
    if (!workspaceId || !decisionId || !action) {
      return res.status(400).json({ error: "workspaceId, decisionId and action are required" });
    }
    if (!actor?.id) return res.status(400).json({ error: "actor.id is required" });

    const outcome = await decideAgentApproval({ workspaceId, decisionId, action, actor });
    if (!outcome.ok && outcome.status === "forbidden") return res.status(403).json(outcome);
    return res.json(outcome);
  } catch (err) {
    console.error("[agent-execution] decide failed:", err);
    return res.status(500).json({ error: "agent_decide_failed", detail: err.message });
  }
});

/** Read one decision's audit trail — what the "view audit" link in chat opens. */
router.get("/agent/execution/decision/:decisionId", requireInternalServiceSecret, async (req, res) => {
  try {
    const workspaceId = req.query?.workspaceId || null;
    if (!workspaceId) return res.status(400).json({ error: "workspaceId is required" });
    const decisions = await store.listDecisions({ workspaceId });
    const decision = decisions.find((d) => d.decision_id === req.params.decisionId);
    if (!decision) return res.status(404).json({ error: "decision_not_found" });
    const events = await store.listDecisionEvents({ workspaceId, decisionId: req.params.decisionId });
    return res.json({ decision, events });
  } catch (err) {
    return res.status(500).json({ error: "agent_decision_read_failed", detail: err.message });
  }
});

export default router;
