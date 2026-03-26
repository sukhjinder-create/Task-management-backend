// middleware/workspace.middleware.js

/**
 * Enforces workspace isolation for normal users.
 * Assumes:
 *  - authMiddleware has already populated req.user
 *  - each user belongs to exactly ONE workspace
 *
 * This middleware:
 *  - sets req.workspaceId
 *  - attaches req.workspace
 *  - blocks requests if workspace is missing or inactive
 *
 * Superadmins are NOT allowed through this middleware.
 */

import crypto from "crypto";
import pool from "../db.js";
import { getWorkspaceById } from "../repositories/workspace.repository.js";
import { getPlanBySlug } from "../repositories/billingPlans.repository.js";

// All feature keys — granted in full during a free trial
const ALL_FEATURE_KEYS = [
  "task_management","project_management","my_tasks","subtasks","comments","file_uploads",
  "notifications","tags","dashboard","profile","time_tracking","sprints","custom_workflows",
  "issue_templates","saved_filters","basic_reporting","advanced_analytics","export_data",
  "leave_management","attendance","okr_goals","performance_reviews","wiki_docs","team_chat",
  "video_huddle","ai_hub","ai_autopilot","ai_testing_agent","strategic_intel",
  "integrations_basic","integrations_pro","integrations_unlimited","slack_migration",
  "asana_migration","git_automation","mfa","sso_saml","audit_logs_30d","audit_logs_full",
  "gdpr_tools","api_access","webhooks","custom_branding","dedicated_manager",
  "sla_guarantee","onpremise","support_community","support_email","support_priority",
  "support_dedicated",
];

export async function requireWorkspaceForUser(req, res, next) {
  // authMiddleware must run first
  if (!req.user) {
    return res.status(401).json({ error: "Unauthenticated" });
  }

  // Superadmin must never use tenant routes
  if (
    String(req.user.role || "").toLowerCase() === "superadmin"
  ) {
    return res
      .status(403)
      .json({ error: "Superadmin cannot access workspace routes" });
  }

  const workspaceId =
    req.user.workspace_id ||
    req.user.workspaceId || // fallback for older payloads
    null;

  if (!workspaceId) {
    return res.status(400).json({
      error: "Workspace not assigned to user",
    });
  }

  // 🔐 Attach ID immediately (used by logging / tracing)
  req.workspaceId = workspaceId;

  // 🔎 Load workspace from DB
  let workspace;
  try {
    workspace = await getWorkspaceById(workspaceId);
  } catch (err) {
    console.error("Workspace lookup failed:", err);
    return res
      .status(500)
      .json({ error: "Failed to verify workspace" });
  }

  if (!workspace) {
    return res.status(404).json({
      error: "Workspace not found",
    });
  }

  // 🚫 Enforce workspace status
  if (workspace.status && workspace.status !== "active") {
    return res.status(403).json({
      error: `Workspace is ${workspace.status}`,
    });
  }

  // 🔐 Attach full workspace for downstream use
  req.workspace = workspace;

  // Check if workspace is on an active free trial
  const trialEndsAt = workspace.trial_ends_at ? new Date(workspace.trial_ends_at) : null;
  const isOnTrial   = trialEndsAt && trialEndsAt > new Date();

  if (isOnTrial) {
    // Trial active → grant every feature
    req.workspace.planFeatures = ALL_FEATURE_KEYS;
    req.workspace.onTrial      = true;
    req.workspace.trialEndsAt  = workspace.trial_ends_at;

    // Log this IP for trial abuse auditing (fire-and-forget, non-blocking)
    try {
      const rawIp = req.ip || req.socket?.remoteAddress || "";
      if (rawIp) {
        const ipHash = crypto.createHash("sha256").update(rawIp).digest("hex");
        pool.query(
          `INSERT INTO trial_ip_log (ip_hash, workspace_id, user_id) VALUES ($1, $2, $3)`,
          [ipHash, workspaceId, req.user.id]
        ).catch(() => {});
      }
    } catch { /* silent */ }
  } else {
    req.workspace.onTrial     = false;
    req.workspace.trialEndsAt = workspace.trial_ends_at || null;

    // Load billing plan features from DB
    try {
      const planSlug = workspace.billing_plan || workspace.plan || null;
      if (planSlug) {
        const plan = await getPlanBySlug(planSlug);
        req.workspace.planFeatures = Array.isArray(plan?.features) ? plan.features : [];
      } else {
        req.workspace.planFeatures = [];
      }
    } catch {
      req.workspace.planFeatures = [];
    }
  }

  next();
}
