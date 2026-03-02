import express from "express";
import {
  fetchYouTrackProjects,
  fetchYouTrackProjectTasks
} from "./youtrack.viewer.service.js";
import youtrackAdapter from "./youtrack.adapter.js";

const router = express.Router();

router.get("/projects", async (req, res) => {

  // ✅ CRITICAL — disable browser caching
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");

  const data = await fetchYouTrackProjects(req.workspaceId);

  res.status(200).json({ data });
});

router.get("/projects/:projectId/tasks", async (req, res) => {

  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");

  const data = await fetchYouTrackProjectTasks(
    req.workspaceId,
    req.params.projectId
  );

  res.status(200).json({ data });
});

router.patch("/tasks/:taskId/status", async (req, res) => {
  try {
    const { completed } = req.body;

    const result =
      await youtrackAdapter.updateTaskStatus(
        req.workspaceId,
        req.params.taskId,
        completed
      );

    res.json(result);
  } catch (err) {

  console.error("🔥 FULL YOUTRACK ERROR:");
  console.error("STATUS:", err.response?.status);
  console.error("DATA:", err.response?.data);
  console.error("MESSAGE:", err.message);

  res.status(500).json({
    error: err.response?.data || err.message
  });
}
});

export default router;