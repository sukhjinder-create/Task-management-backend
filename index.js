import "dotenv/config";
import express from "express";
import http from "http";
import cors from "cors";
import helmet from "helmet";

// ---------------- ROUTES (UNCHANGED) ----------------
import projectRoutes from "./routes/project.routes.js";
import sprintRoutes from "./routes/sprint.routes.js";
import userRoutes from "./routes/user.routes.js";
import workspaceRoutes from "./routes/workspace.routes.js";
import taskRoutes from "./routes/task.routes.js";
import commentRoutes from "./routes/comment.routes.js";
import authRoutes from "./routes/auth.routes.js";
import notificationRoutes from "./routes/notification.routes.js";
import uploadRoutes from "./routes/upload.routes.js";
import attendanceRoutes from "./routes/attendance.routes.js";
import subtaskRoutes from "./routes/subtask.routes.js";
import projectStatusRoutes from "./routes/projectStatus.routes.js";
import reportRoutes from "./routes/report.routes.js";
import dashboardRoutes from "./routes/dashboard.routes.js";
import operationsRoutes from "./routes/operations.routes.js";
import testingAgentRoutes from "./routes/testingAgent.routes.js";
import { startAttendanceCron } from "./cron/attendance.cron.js";
import { startAutopilotCron } from "./cron/autopilot.cron.js";
import { startMonthlyIntelligenceCron } from "./cron/monthlyIntelligence.cron.js";
import { startReviewsCron } from "./cron/reviews.cron.js";
import { startBackupCron } from "./cron/backup.cron.js";
import { startHuddleIntelligenceCron } from "./cron/huddleIntelligence.cron.js";

// 🔵 Chat channels
import chatMessagesRoutes from "./routes/chatMessages.routes.js";
import chatChannelRoutes from "./routes/chatChannels.routes.js";
import cryptoRoutes from "./routes/crypto.routes.js";
import { markChannelRead, getUnreadCounts } from "./services/chat.service.js";

import { initSocket } from "./realtime/socket.js";

import { authMiddleware } from "./middleware/auth.middleware.js";
import { requireWorkspaceForUser } from "./middleware/workspace.middleware.js";
import { requirePlanFeature } from "./middleware/plan.middleware.js";
import { allowRoles } from "./middleware/role.middleware.js";

import superadminAuthRoutes from "./routes/superadminAuth.routes.js";
import superadminWorkspaceRoutes from "./routes/superadminWorkspaces.routes.js";
import superadminPlansRoutes from "./routes/superadminPlans.routes.js";
import superadminGrowthRoutes from "./routes/superadminGrowth.routes.js";
import superadminAdaptiveIntelligenceRoutes from "./routes/superadminAdaptiveIntelligence.routes.js";
import superadminAiStudioRoutes from "./routes/superadminAiStudio.routes.js";
import aiStudioWorkspaceRoutes from "./routes/aiStudioWorkspace.routes.js";
import backupRoutes from "./routes/backup.routes.js";
import growthRoutes from "./routes/growth.routes.js";
import { growthProductTelemetry } from "./growth/growthProductTelemetry.middleware.js";

import adminAttendanceRoutes from "./routes/adminAttendance.routes.js";
import adminAttendanceRecalculateRoutes from "./routes/adminAttendanceRecalculate.routes.js";
import adminAttendanceExportRoutes from "./routes/adminAttendanceExport.routes.js";
import settingsAttendanceRoutes from "./routes/settingsAttendance.routes.js";
import aiPlatformInvokeRoutes from "./routes/aiPlatformInvoke.routes.js";

import aiRoutes from "./ai/ai.routes.js";
import internalRoutes from "./routes/internal.js";
import internalTasks from "./routes/internalTasks.js";
import reportsRouter from "./routes/reports.js";
// 🧠 Intelligence (READ-ONLY)
import intelligenceRoutes from "./intelligence/intelligence.routes.js";
// 🤖 Autopilot AI
import autopilotRoutes from "./routes/autopilot.routes.js";
import adaptiveRoutes from "./routes/adaptive.routes.js";

// ---------------- EVENTS / AI OBSERVATION (NEW) ----------------
import { bootstrapAdaptivePlatform } from "./adaptive/bootstrap.js";
import { getCorsAllowedOrigins, isProductionRuntime } from "./config/environment.js";

// 🔥 NEW: Service observer (NON-INVASIVE)

// 🔥 NEW: Import services ONLY to wrap them (no logic change)
import huddleIceService from "./services/huddleIce.service.js";
import universalIntegrationRoutes from "./integrations/core/integration.routes.js";
import integrationRoutes from "./routes/integration.routes.js";
import integrationDebugRoutes from "./routes/integrationDebug.routes.js";
import asanaOAuthRoutes from "./integrations/asana/asana.oauth.routes.js";
import asanaViewerRoutes from "./integrations/asana/asana.viewer.routes.js";
import youtrackRoutes
  from "./integrations/youtrack/youtrack.routes.js";
import youtrackViewerRoutes
  from "./integrations/youtrack/youtrack.viewer.routes.js";
import {
  gitAutomationRoutes,
  gitAutomationWebhookRoutes,
} from "./integrations/git/git.automation.routes.js";
import {
  integrationWebhookReceiverRoutes,
  integrationWebhookSetupRoutes,
} from "./integrations/webhooks/integration.webhook.routes.js";
import slackMigrationRoutes from "./integrations/slack/slack.migration.routes.js";
import migrationHistoryRoutes from "./routes/migrationHistory.routes.js";
import tagsRoutes from "./routes/tags.routes.js";
import taskLinksRoutes from "./routes/taskLinks.routes.js";
import timeTrackingRoutes from "./routes/timeTracking.routes.js";
import watchersRoutes from "./routes/watchers.routes.js";
import votesRoutes from "./routes/votes.routes.js";
import issueTemplatesRoutes from "./routes/issueTemplates.routes.js";
import savedFiltersRoutes from "./routes/savedFilters.routes.js";

// ─── Enterprise Phase 1-4 ─────────────────────────────────────────────────────
import auditRoutes    from "./routes/audit.routes.js";
import mfaRoutes      from "./routes/mfa.routes.js";
import ssoRoutes      from "./routes/sso.routes.js";
import wikiRoutes     from "./routes/wiki.routes.js";
import leaveRoutes    from "./routes/leave.routes.js";
import holidaysRoutes from "./routes/holidays.routes.js";
import goalsRoutes    from "./routes/goals.routes.js";
import reviewsRoutes  from "./routes/reviews.routes.js";
import gdprRoutes     from "./routes/gdpr.routes.js";
import apiKeysRoutes  from "./routes/apiKeys.routes.js";
import webhooksRoutes    from "./routes/webhooks.routes.js";
import aiFeaturesRoutes from "./routes/aiFeatures.routes.js";
import paymentsRoutes, {
  razorpayWebhookRouter,
  webhookRouter as paymentsWebhookRouter,
} from "./routes/payments.routes.js";
import publicBillingRoutes from "./routes/publicBilling.routes.js";
import pushRoutes from "./routes/push.routes.js";
import appVersionRoutes from "./routes/appVersion.routes.js";
import huddleArtifactRoutes from "./routes/huddleArtifact.routes.js";
import huddleIntelligenceRoutes from "./routes/huddleIntelligence.routes.js";
import huddleMediaRoutes from "./routes/huddleMedia.routes.js";
import huddleTranscriptionRoutes from "./routes/huddleTranscription.routes.js";
import huddleTranscriptRoutes from "./routes/huddleTranscript.routes.js";
import huddleCallTraceRoutes from "./routes/huddleCallTrace.routes.js";




const app = express();

app.set("etag", false);
app.set("trust proxy", true);
app.disable("x-powered-by");

app.use((req, res, next) => {
  console.log("🌍 GLOBAL REQUEST:", req.method, req.originalUrl);
  next();
});

// ---------------- MIDDLEWARE ----------------
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow web dev server, Electron, Capacitor (Android/iOS), and direct API calls
      const allowed = getCorsAllowedOrigins();
      if (!origin || allowed.has(origin)) {
        callback(null, true);
      } else if (!isProductionRuntime()) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    credentials: true,
    methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "x-workspace-id",
      "x-growth-anonymous-id",
      "x-growth-session-id",
      "x-correlation-id",
      "x-internal-service-secret",
      "x-ai-service-secret",
      "Cache-Control"
    ],
  })
);

// OLD integrations (existing — DO NOT TOUCH)
app.use("/integrations", integrationRoutes);

// Payment webhooks must see the untouched raw body for signature verification.
app.use("/payments/webhook", paymentsWebhookRouter);
app.use("/payments/razorpay/webhook", razorpayWebhookRouter);

app.use(express.json({
  limit: "50mb",
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(growthProductTelemetry);

app.use("/integration-webhooks", integrationWebhookReceiverRoutes);
app.use(
  "/integrations/webhooks",
  authMiddleware,
  requireWorkspaceForUser,
  allowRoles("admin"),
  integrationWebhookSetupRoutes
);

app.use("/oauth/asana", asanaOAuthRoutes);
app.use("/integrations/asana", asanaViewerRoutes);

// CONNECT + MIGRATION
app.use(
  "/integrations/youtrack",
  authMiddleware,
  requireWorkspaceForUser,
  allowRoles("admin"),
  youtrackRoutes
);

// VIEWER (projects + tasks)
app.use(
  "/integrations/youtrack",
  authMiddleware,
  requireWorkspaceForUser,
  allowRoles("admin"),
  youtrackViewerRoutes
);

// Slack migration
app.use(
  "/integrations/slack",
  authMiddleware,
  requireWorkspaceForUser,
  allowRoles("admin"),
  slackMigrationRoutes
);

// Migration history (all sources)
app.use(
  "/migration-history",
  authMiddleware,
  requireWorkspaceForUser,
  allowRoles("admin"),
  migrationHistoryRoutes
);

// NEW universal adapter routes (SAFE ADDITION)
app.use(
  "/integrations",
  authMiddleware,
  requireWorkspaceForUser,
  allowRoles("admin"),
  universalIntegrationRoutes
);
app.use("/uploads", express.static("uploads"), (req, res) => {
  res.status(404).json({ error: "File not found" });
});
app.use("/upload", uploadRoutes);

// ---------------- ROUTES ----------------
app.get("/", (req, res) => {
  res.send("Task Management API is running 🚀");
});
app.get("/version", (req, res) => res.json({
  commit: process.env.RELEASE_COMMIT || "unknown",
  built: process.env.RELEASE_BUILT_AT || null,
  service: "asystence-api",
}));

app.use("/auth", authRoutes);
app.use("/public/billing", publicBillingRoutes);
app.use("/growth", growthRoutes);
app.use("/crypto", cryptoRoutes);
app.use("/ai", aiRoutes);
app.use("/ai", aiPlatformInvokeRoutes); // POST /ai/invoke — single external door into the platform
app.use("/internal", internalRoutes);
app.use(internalTasks);

// ── Superadmin routes MUST be before any global authMiddleware ──
app.use("/superadmin", superadminAuthRoutes);
app.use("/superadmin/workspaces", superadminWorkspaceRoutes);
app.use("/superadmin/plans", superadminPlansRoutes);
app.use("/superadmin/backups", backupRoutes);
app.use("/superadmin/growth", superadminGrowthRoutes);
app.use("/superadmin/adaptive-intelligence", superadminAdaptiveIntelligenceRoutes);
app.use("/superadmin/ai-studio", superadminAiStudioRoutes);
app.use("/app-version", appVersionRoutes);

// Public endpoint — no auth required (must be before any catch-all authMiddleware)
app.get("/ice-servers", (req, res) => {
  res.json(huddleIceService.getIceServersPayload());
});

app.use(authMiddleware, requireWorkspaceForUser, reportsRouter);
// 🧠 Intelligence APIs (READ-ONLY, UI-facing)
app.use(
  "/intelligence",
  authMiddleware,
  requireWorkspaceForUser,
  intelligenceRoutes
);
// 🤖 Autopilot AI — plan-gated
app.use("/autopilot",     authMiddleware, requireWorkspaceForUser, requirePlanFeature("ai_autopilot"),    autopilotRoutes);
app.use("/adaptive",      authMiddleware, requireWorkspaceForUser, adaptiveRoutes);
app.use("/dashboard",     dashboardRoutes);
app.use("/operations",    authMiddleware, requireWorkspaceForUser, allowRoles("admin"), requirePlanFeature("workspace_search_memory"), operationsRoutes);
app.use("/ai-studio",     authMiddleware, requireWorkspaceForUser, allowRoles("admin"), aiStudioWorkspaceRoutes);
// 🧪 Testing Agent — plan-gated
app.use("/testing-agent", authMiddleware, requireWorkspaceForUser, requirePlanFeature("ai_testing_agent"), testingAgentRoutes);



app.use("/projects", authMiddleware, requireWorkspaceForUser, projectRoutes);
app.use("/tasks", authMiddleware, requireWorkspaceForUser, taskRoutes);
app.use("/", authMiddleware, requireWorkspaceForUser, sprintRoutes);
app.use("/comments", authMiddleware, requireWorkspaceForUser, commentRoutes);
app.use("/subtasks", authMiddleware, requireWorkspaceForUser, subtaskRoutes);
app.use("/project-statuses", authMiddleware, requireWorkspaceForUser, projectStatusRoutes);
app.use("/reports", authMiddleware, requireWorkspaceForUser, requirePlanFeature("basic_reporting"), reportRoutes);
app.use("/notifications", authMiddleware, requireWorkspaceForUser, notificationRoutes);
app.use("/attendance", authMiddleware, requireWorkspaceForUser, attendanceRoutes);
app.use("/settings", authMiddleware, requireWorkspaceForUser, settingsAttendanceRoutes);
app.use("/users", authMiddleware, requireWorkspaceForUser, userRoutes);
app.use("/workspaces", authMiddleware, requireWorkspaceForUser, workspaceRoutes);

// Direct handlers — avoids router mounting ambiguity
app.get("/chat/unread-counts", authMiddleware, requireWorkspaceForUser, async (req, res) => {
  try {
    const counts = await getUnreadCounts(req.user.id, req.workspaceId);
    res.json(counts);
  } catch (err) {
    console.error("[unread] getUnreadCounts error:", err.message);
    res.status(500).json({ error: err.message });
  }
});
app.post("/chat/mark-read", authMiddleware, requireWorkspaceForUser, async (req, res) => {
  try {
    const { channelKey } = req.body;
    if (!channelKey) return res.status(400).json({ error: "channelKey required" });
    await markChannelRead(req.user.id, channelKey);
    res.json({ ok: true });
  } catch (err) {
    console.error("[unread] markChannelRead error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.use("/chat/messages", authMiddleware, requireWorkspaceForUser, requirePlanFeature("team_chat"), chatMessagesRoutes);
app.use("/chat",          authMiddleware, requireWorkspaceForUser, requirePlanFeature("team_chat"), chatChannelRoutes);
app.use("/huddle/artifacts", authMiddleware, requireWorkspaceForUser, huddleArtifactRoutes);
app.use("/huddle/intelligence", authMiddleware, requireWorkspaceForUser, huddleIntelligenceRoutes);
app.use("/huddle/call-trace", authMiddleware, requireWorkspaceForUser, huddleCallTraceRoutes);
app.use("/huddle/media",  authMiddleware, requireWorkspaceForUser, huddleMediaRoutes);
app.use("/huddle/transcription", authMiddleware, requireWorkspaceForUser, huddleTranscriptionRoutes);
app.use("/huddle/transcripts", authMiddleware, requireWorkspaceForUser, huddleTranscriptRoutes);

// Admin attendance — fully protected (auth + workspace + attendance plan feature)
app.use("/admin/attendance", authMiddleware, requireWorkspaceForUser, requirePlanFeature("attendance"), adminAttendanceRoutes);
app.use("/admin/attendance", authMiddleware, requireWorkspaceForUser, requirePlanFeature("attendance"), adminAttendanceRecalculateRoutes);
app.use("/admin/attendance", authMiddleware, requireWorkspaceForUser, requirePlanFeature("attendance"), adminAttendanceExportRoutes);

// ── YouTrack parity features ──────────────────────────
app.use("/tags",            authMiddleware, requireWorkspaceForUser, tagsRoutes);
app.use("/task-links",      authMiddleware, requireWorkspaceForUser, taskLinksRoutes);
app.use("/time-tracking",   authMiddleware, requireWorkspaceForUser, requirePlanFeature("time_tracking"),   timeTrackingRoutes);
app.use("/watchers",        authMiddleware, requireWorkspaceForUser, watchersRoutes);
app.use("/votes",           authMiddleware, requireWorkspaceForUser, votesRoutes);
app.use("/issue-templates", authMiddleware, requireWorkspaceForUser, requirePlanFeature("issue_templates"), issueTemplatesRoutes);
app.use("/saved-filters",   authMiddleware, requireWorkspaceForUser, requirePlanFeature("saved_filters"),   savedFiltersRoutes);

// ─── Enterprise Phase 1-4 routes ─────────────────────────────────────────────
// All sub-features of the Enterprise module share the same feature gate
// ("custom_branding" = the Enterprise module key). If the module is off in the
// plan, every endpoint inside it is blocked — URL-bypass proof.
const enterpriseGate = requirePlanFeature("custom_branding");
app.use("/audit",     authMiddleware, requireWorkspaceForUser, enterpriseGate, auditRoutes);
app.use("/gdpr",      authMiddleware, requireWorkspaceForUser, enterpriseGate, gdprRoutes);
app.use("/api-keys",  authMiddleware, requireWorkspaceForUser, enterpriseGate, apiKeysRoutes);
app.use("/webhooks",  authMiddleware, requireWorkspaceForUser, enterpriseGate, webhooksRoutes);
app.use("/mfa",       mfaRoutes);   // authMiddleware applied inside the router
app.use("/auth/sso",  ssoRoutes);   // public SAML endpoints + auth-protected config
app.use("/wiki",      authMiddleware, requireWorkspaceForUser, requirePlanFeature("wiki_docs"),            wikiRoutes);
app.use("/leave",     authMiddleware, requireWorkspaceForUser, requirePlanFeature("leave_management"),     leaveRoutes);
app.use("/holidays",  authMiddleware, requireWorkspaceForUser, requirePlanFeature("leave_management"),     holidaysRoutes);
app.use("/goals",     authMiddleware, requireWorkspaceForUser, requirePlanFeature("okr_goals"),            goalsRoutes);
app.use("/reviews",   authMiddleware, requireWorkspaceForUser, requirePlanFeature("performance_reviews"),  reviewsRoutes);
app.use("/ai-features", authMiddleware, requireWorkspaceForUser, requirePlanFeature("ai_hub"),            aiFeaturesRoutes);
app.use("/payments",  authMiddleware, requireWorkspaceForUser, paymentsRoutes);
app.use("/push",       pushRoutes);


app.use("/integration-debug", authMiddleware, requireWorkspaceForUser, allowRoles("admin"), integrationDebugRoutes);
app.use("/integrations/git", authMiddleware, requireWorkspaceForUser, gitAutomationRoutes);
app.use("/webhooks/git", gitAutomationWebhookRoutes);


// ---------------- ERROR HANDLER ----------------
app.use((err, req, res, next) => {
  // JSON parsing error
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    console.error("🔥 JSON parsing error:", err.message);
    return res.status(400).json({
      error: "Invalid JSON in request body",
      details: err.message,
      hint: "Check for trailing commas, missing quotes, or other JSON syntax errors"
    });
  }

  // Payload too large
  if (err && (err.type === "entity.too.large" || err.status === 413)) {
    console.error("Payload too large:", err.message);
    return res.status(413).json({
      error:
        "Request is too large. Try reducing the size of the description or attachments.",
    });
  }

  // Generic error
  console.error("Unhandled error:", err);
  next(err);
});

// ---------------- SERVER ----------------
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

initSocket(server, [...getCorsAllowedOrigins()]);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// ---------------- EVENT SYSTEM BOOTSTRAP ----------------

bootstrapAdaptivePlatform();

// 2️⃣ Wrap services AFTER observers exist

// 3️⃣ NOW start integrations (AFTER observers ready)
await import("./integrations/integration.bootstrap.js");

// 4️⃣ Start cron LAST
startAttendanceCron();
startAutopilotCron();
startMonthlyIntelligenceCron();
startReviewsCron();
startBackupCron();
startHuddleIntelligenceCron();
