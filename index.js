// index.js
import express from "express";
import http from "http";
import cors from "cors";
import projectRoutes from "./routes/project.routes.js";
import userRoutes from "./routes/user.routes.js";
import taskRoutes from "./routes/task.routes.js";
import commentRoutes from "./routes/comment.routes.js";
import authRoutes from "./routes/auth.routes.js";
import notificationRoutes from "./routes/notification.routes.js";
import uploadRoutes from "./routes/upload.routes.js";
import attendanceRoutes from "./routes/attendance.routes.js";
import { initSocket } from "./realtime/socket.js";
import dotenv from "dotenv";

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

app.use("/auth", authRoutes);
app.use("/projects", projectRoutes);
app.use("/users", userRoutes);
app.use("/tasks", taskRoutes);
app.use("/comments", commentRoutes);
app.use("/notifications", notificationRoutes);
app.use("/attendance", attendanceRoutes);

// Optional: global error handler so PayloadTooLargeError comes back as JSON
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

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
