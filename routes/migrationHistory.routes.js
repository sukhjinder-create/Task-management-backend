import express from "express";
import { getMigrationHistory, deleteMigrationImport } from "../services/migrationHistory.service.js";

const router = express.Router();

// GET /migration-history?source=slack
router.get("/", async (req, res) => {
  try {
    const { source } = req.query;
    const history = await getMigrationHistory(req.workspaceId, source || null);
    res.json(history);
  } catch (err) {
    console.error("Migration history fetch error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /migration-history/:importId
router.delete("/:importId", async (req, res) => {
  try {
    const result = await deleteMigrationImport(req.params.importId, req.workspaceId);
    res.json(result);
  } catch (err) {
    console.error("Migration delete error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
