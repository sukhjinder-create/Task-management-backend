// realtime/socket.js
import { Server } from "socket.io";
import jwt from "jsonwebtoken";

let io;
const JWT_SECRET = process.env.JWT_SECRET || "task_management_secret";

export function initSocket(server) {
  io = new Server(server, {
    cors: {
      origin: "http://localhost:5173",
      credentials: true,
    },
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error("Unauthorized: no token"));
    }
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      socket.user = payload; // { id, username, email, role }
      next();
    } catch (err) {
      console.error("Socket auth error", err.message);
      next(new Error("Unauthorized: invalid token"));
    }
  });

  io.on("connection", (socket) => {
    const userId = socket.user.id;
    socket.join(userId);
    console.log("Socket connected for user:", userId);

    socket.on("disconnect", () => {
      console.log("Socket disconnected:", userId);
    });
  });
}

export function getIO() {
  if (!io) throw new Error("Socket.io not initialized");
  return io;
}
