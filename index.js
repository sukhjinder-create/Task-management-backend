import "dotenv/config";
console.log("ENV CHECK", {
  AI_SERVICE_URL: process.env.AI_SERVICE_URL,
  AI_SERVICE_SECRET: process.env.AI_SERVICE_SECRET,
});
import express from "express";
import http from "http";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";  // Add axios to your imports

// ---------------- ROUTES (UNCHANGED) ----------------
import projectRoutes from "./routes/project.routes.js";
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
import testingAgentRoutes from "./routes/testingAgent.routes.js";
import { startAttendanceCron } from "./cron/attendance.cron.js";
import { startAutopilotCron } from "./cron/autopilot.cron.js";

// 🔵 Chat channels
import chatMessagesRoutes from "./routes/chatMessages.routes.js";
import chatChannelRoutes from "./routes/chatChannels.routes.js";
import cryptoRoutes from "./routes/crypto.routes.js";

import { initSocket } from "./realtime/socket.js";

import { authMiddleware } from "./middleware/auth.middleware.js";
import { requireWorkspaceForUser } from "./middleware/workspace.middleware.js";

import superadminAuthRoutes from "./routes/superadminAuth.routes.js";
import superadminWorkspaceRoutes from "./routes/superadminWorkspaces.routes.js";
import superadminRoutes from "./routes/superadmin.routes.js";

import adminAttendanceRoutes from "./routes/adminAttendance.routes.js";
import adminAttendanceRecalculateRoutes from "./routes/adminAttendanceRecalculate.routes.js";
import adminAttendanceExportRoutes from "./routes/adminAttendanceExport.routes.js";
import settingsAttendanceRoutes from "./routes/settingsAttendance.routes.js";

import aiRoutes from "./ai/ai.routes.js";
import internalRoutes from "./routes/internal.js";
import internalTasks from "./routes/internalTasks.js";
import reportsRouter from "./routes/reports.js";
// 🧠 Intelligence (READ-ONLY)
import intelligenceRoutes from "./intelligence/intelligence.routes.js";
// 🤖 Autopilot AI
import autopilotRoutes from "./routes/autopilot.routes.js";

// ---------------- EVENTS / AI OBSERVATION (NEW) ----------------
import { registerObserver } from "./events/eventBus.js";
import { aiObserver } from "./events/observers/aiObserver.js";

// 🔥 NEW: Service observer (NON-INVASIVE)
import { observeService } from "./events/observers/serviceObserver.js";

// 🔥 NEW: Import services ONLY to wrap them (no logic change)
import projectService from "./services/project.service.js";
import * as taskService from "./services/task.service.js";
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




const app = express();

app.set("etag", false);

app.use((req, res, next) => {
  console.log("🌍 GLOBAL REQUEST:", req.method, req.originalUrl);
  next();
});

// ---------------- MIDDLEWARE ----------------
app.use(
  cors({
    origin: "http://localhost:5173",
    credentials: true,
    methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "x-workspace-id",
      "Cache-Control"
    ],
  })
);

// OLD integrations (existing — DO NOT TOUCH)
app.use("/integrations", integrationRoutes);

app.use(express.json({
  limit: "50mb",
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use("/oauth/asana", asanaOAuthRoutes);
app.use("/integrations/asana", asanaViewerRoutes);

// CONNECT + MIGRATION
app.use(
  "/integrations/youtrack",
  authMiddleware,
  requireWorkspaceForUser,
  youtrackRoutes
);

// VIEWER (projects + tasks)
app.use(
  "/integrations/youtrack",
  authMiddleware,
  requireWorkspaceForUser,
  youtrackViewerRoutes
);

// NEW universal adapter routes (SAFE ADDITION)
app.use("/integrations", universalIntegrationRoutes);
app.use("/uploads", express.static("uploads"));
app.use("/upload", uploadRoutes);

// ---------------- ROUTES ----------------
app.get("/", (req, res) => {
  res.send("Task Management API is running 🚀");
});

app.use("/auth", authRoutes);
app.use("/crypto", cryptoRoutes);
app.use("/ai", aiRoutes);
app.use("/internal", internalRoutes);
app.use(internalTasks);
app.use(reportsRouter);
// 🧠 Intelligence APIs (READ-ONLY, UI-facing)
app.use(
  "/intelligence",
  authMiddleware,
  requireWorkspaceForUser,
  intelligenceRoutes
);
// 🤖 Autopilot AI
app.use("/autopilot", autopilotRoutes);
app.use("/dashboard", dashboardRoutes);
app.use("/testing-agent", authMiddleware, requireWorkspaceForUser, testingAgentRoutes);

app.use("/projects", authMiddleware, requireWorkspaceForUser, projectRoutes);
app.use("/tasks", authMiddleware, requireWorkspaceForUser, taskRoutes);
app.use("/comments", authMiddleware, requireWorkspaceForUser, commentRoutes);
app.use("/subtasks", authMiddleware, requireWorkspaceForUser, subtaskRoutes);
app.use("/project-statuses", authMiddleware, requireWorkspaceForUser, projectStatusRoutes);
app.use("/reports", authMiddleware, requireWorkspaceForUser, reportRoutes);
app.use("/notifications", authMiddleware, requireWorkspaceForUser, notificationRoutes);
app.use("/attendance", authMiddleware, requireWorkspaceForUser, attendanceRoutes);
app.use("/settings", authMiddleware, requireWorkspaceForUser, settingsAttendanceRoutes);
app.use("/users", authMiddleware, requireWorkspaceForUser, userRoutes);
app.use("/workspaces", authMiddleware, requireWorkspaceForUser, workspaceRoutes);

app.use("/superadmin", superadminAuthRoutes);
app.use("/superadmin/workspaces", superadminWorkspaceRoutes);
app.use("/superadmin", superadminRoutes);

app.use(
  "/chat/messages",
  authMiddleware,
  requireWorkspaceForUser,
  chatMessagesRoutes
);
app.use("/chat", authMiddleware, requireWorkspaceForUser, chatChannelRoutes);

app.use("/admin/attendance", adminAttendanceRoutes);
app.use("/admin/attendance", adminAttendanceRecalculateRoutes);
app.use("/admin/attendance", adminAttendanceExportRoutes);

app.use("/integration-debug", integrationDebugRoutes);
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

initSocket(server, process.env.FRONTEND_BASE_URL);

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// ---------------- EVENT SYSTEM BOOTSTRAP ----------------

import { executionSignalObserver } from "./events/observers/executionSignal.observer.js";
registerObserver(executionSignalObserver);

// 2️⃣ Wrap services AFTER observers exist
observeService(projectService, "project");
observeService(taskService, "task");

// 3️⃣ NOW start integrations (AFTER observers ready)
await import("./integrations/integration.bootstrap.js");

// 4️⃣ Start cron LAST
startAttendanceCron();
startAutopilotCron();
