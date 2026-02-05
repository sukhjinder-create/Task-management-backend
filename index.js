console.log("ENV CHECK", {
  AI_SERVICE_URL: process.env.AI_SERVICE_URL,
  AI_SERVICE_SECRET: process.env.AI_SERVICE_SECRET,
});
import "dotenv/config";
import express from "express";
import http from "http";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";  // Add axios to your imports
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
import { startAttendanceCron } from "./cron/attendance.cron.js";


// 🔵 NEW: chat channels (Slack-like channels)
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
import aiRoutes from "./ai/ai.routes.js";
import internalRoutes from "./routes/internal.js";
import internalTasks from "./routes/internalTasks.js";








dotenv.config();

const app = express();

// ----- MIDDLEWARE -----

// CORS – allow your frontend (adjust origin if needed)
app.use(
  cors({
    origin: process.env.FRONTEND_BASE_URL,
    credentials: true,
  })
);

// 🔥 Increase body size limits (for rich text + images in description)
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Make uploaded files accessible
app.use("/uploads", express.static("uploads"));

// Rich text editor uploads (handled by multer in upload.routes.js)
app.use("/upload", uploadRoutes);

// ----- ROUTES -----

app.get("/", (req, res) => {
  res.send("Task Management API is running 🚀");
});

/**
 * Public / unauthenticated routes
 * - Authentication must not be workspace-scoped
 */
app.use("/auth", authRoutes);
app.use("/crypto", cryptoRoutes);
app.use("/ai", aiRoutes);
app.use("/internal", internalRoutes);
app.use(internalTasks);
/**
 * Superadmin routes (only superadmins)
 * - These routes are allowed to operate across workspaces
 * - They expect the handlers to be protected by requireSuperadmin
 *
 * Example: you should mount a superadmin router at /superadmin that uses
 * requireSuperadmin internally; if not, you can mount here like:
 *   app.use("/superadmin", authMiddleware, requireSuperadmin, superadminRoutes);
 *
 * (I chose to import superadmin routes only if/when you add them)
 */

/**
 * Tenant-scoped routes (apply auth + workspace middleware centrally)
 *
 * Any request to these endpoints will:
 *  1) run authMiddleware (attach req.user from JWT)
 *  2) run requireWorkspaceForUser (attach req.workspaceId and enforce non-superadmin users have a workspace)
 *
 * This means you DON'T need to add requireWorkspaceForUser inside each route file.
 * If a route file already calls authMiddleware, double-auth will still work safely.
 */
app.use("/projects", authMiddleware, requireWorkspaceForUser, projectRoutes);
app.use("/tasks", authMiddleware, requireWorkspaceForUser, taskRoutes);
app.use("/comments", authMiddleware, requireWorkspaceForUser, commentRoutes);
app.use("/subtasks", authMiddleware, requireWorkspaceForUser, subtaskRoutes);
app.use("/project-statuses", authMiddleware, requireWorkspaceForUser, projectStatusRoutes);
app.use("/reports", authMiddleware, requireWorkspaceForUser, reportRoutes);
app.use("/notifications", authMiddleware, requireWorkspaceForUser, notificationRoutes);
app.use("/attendance", authMiddleware, requireWorkspaceForUser, attendanceRoutes);
app.use("/users", authMiddleware, requireWorkspaceForUser, userRoutes);
app.use(
  "/workspaces",
  authMiddleware,
  requireWorkspaceForUser,
  workspaceRoutes
);
app.use("/superadmin", superadminAuthRoutes);

app.use("/superadmin/workspaces", superadminWorkspaceRoutes);
app.use("/superadmin", superadminRoutes);

// 🔵 Chat channels API: tenant-scoped chat channels
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

// Optional: any other tenant routes you add, mount them here with the same pattern.

// Optional: global error handler (keeps PayloadTooLarge JSON response)
app.use((err, req, res, next) => {
  if (err && (err.type === "entity.too.large" || err.status === 413)) {
    console.error("Payload too large:", err.message);
    return res.status(413).json({
      error:
        "Request is too large. Try reducing the size of the description or attachments.",
    });
  }
  next(err);
});


// ----- SERVER + SOCKET.IO -----

const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// 🔥 Pass FRONTEND_BASE_URL into socket init (used for CORS in socket.io)
initSocket(server, process.env.FRONTEND_BASE_URL);

console.log("✅ Workspace routes mounted");

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
// Send events to AI after saving a message
app.post("/save-message", async (req, res) => {
  const savedMessage = req.body.message; // Assuming the saved message is in req.body.message
  // Emit the event to the AI service
  await emitToAI({
    type: 'chat:new-message',
    payload: savedMessage,
  });

  res.status(200).send("Message saved and event sent to AI");
});

startAttendanceCron();

