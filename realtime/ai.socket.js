export function registerAiSocket(io) {
  io.of("/ai").on("connection", (socket) => {
    console.log("🤖 AI connected");

    // Listen for incoming messages from the backend to be sent to the AI socket
    socket.on("ai:new-message", async (payload) => {
      try {
        // Emitting the AI message to the frontend
        socket.emit("chat:new-message", payload);
      } catch (err) {
        console.error("Error emitting message to AI socket:", err);
      }
    });

    // Handle socket disconnection and cleanup
    socket.on("disconnect", () => {
      console.log("🤖 AI disconnected");
    });
  });
}
