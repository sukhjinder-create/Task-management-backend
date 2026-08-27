// routes/goals.routes.js
//
// Goals — replaces the old OKR / Objectives system.
//
// A Goal is a time-boxed target for the workspace.
// Progress is driven by sprint completions.
// If no sprints are linked, progress can be set manually (0–100).
// The intelligence layer monitors all goals and raises signals automatically.
//
// DB table: okr_objectives (kept as-is to avoid breaking existing data)
// Sprint link table: okr_sprint_links (kept as-is)

import express from "express";
import db from "../db.js";
import { logAudit } from "../services/audit.service.js";
import { allowRoles } from "../middleware/role.middleware.js";
import { recalcGoalFromSprints } from "../services/sprint.service.js";

const router = express.Router();

// ─── LIST GOALS ───────────────────────────────────────────────────────────────

router.get("/goals", async (req, res) => {
  try {
    const { timePeriod, ownerId } = req.query;
    const conditions = ["o.workspace_id = $1", "(o.success_measure IS NULL OR o.target_date IS NULL)"];
    const params = [req.workspaceId];
    let i = 2;

    if (timePeriod) { conditions.push(`o.time_period = $${i++}`); params.push(timePeriod); }
    if (ownerId)    { conditions.push(`o.owner_id = $${i++}`);    params.push(ownerId); }

    const { rows } = await db.query(
      `SELECT
         o.id,
         o.workspace_id,
         o.owner_id,
         o.title,
         o.description,
         o.time_period,
         o.status,
         o.progress,
         o.parent_id,
         o.created_at,
         o.updated_at,
         u.username AS owner_name,
         -- Sprints linked to this goal (visible to all; clickable for admin/manager on UI)
         (SELECT json_agg(
                   json_build_object(
                     'sprint_id',     s.id,
                     'sprint_name',   s.name,
                     'sprint_status', s.status,
                     'project_name',  p.name,
                     'is_hidden',     s.is_hidden
                   ) ORDER BY s.created_at
                 )
          FROM okr_sprint_links sl
          JOIN sprints s ON s.id = sl.sprint_id
          JOIN projects p ON p.id = s.project_id
          WHERE sl.objective_id = o.id
         ) AS linked_sprints
       FROM okr_objectives o
       LEFT JOIN users u ON u.id = o.owner_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY o.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CREATE GOAL ──────────────────────────────────────────────────────────────

router.post("/goals", allowRoles("admin", "manager"), async (req, res) => {
  try {
    const { title, description, time_period, owner_id, parent_id } = req.body;
    if (!title || !time_period)
      return res.status(400).json({ error: "title and time_period are required" });

    const { rows } = await db.query(
      `INSERT INTO okr_objectives
         (workspace_id, owner_id, title, description, time_period, parent_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.workspaceId, owner_id || req.user.id, title, description || null, time_period, parent_id || null]
    );
    await logAudit({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      action: "goal.create",
      entityType: "goal",
      entityId: rows[0].id,
      newValue: { title },
    });
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── UPDATE GOAL ──────────────────────────────────────────────────────────────

router.put("/goals/:id", allowRoles("admin", "manager"), async (req, res) => {
  try {
    const { title, description, time_period, status, progress, owner_id } = req.body;

    // Validate manual progress (only used when no sprints are linked)
    if (progress !== undefined && (Number(progress) < 0 || Number(progress) > 100))
      return res.status(400).json({ error: "progress must be between 0 and 100" });

    const { rows } = await db.query(
      `UPDATE okr_objectives SET
         title       = COALESCE($1, title),
         description = COALESCE($2, description),
         time_period = COALESCE($3, time_period),
         status      = COALESCE($4, status),
         progress    = COALESCE($5, progress),
         owner_id    = COALESCE($6, owner_id),
         updated_at  = NOW()
       WHERE id = $7 AND workspace_id = $8
         AND (success_measure IS NULL OR target_date IS NULL)
       RETURNING *`,
      [title, description, time_period, status, progress, owner_id, req.params.id, req.workspaceId]
    );
    if (!rows[0]) return res.status(404).json({ error: "Goal not found" });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE GOAL ──────────────────────────────────────────────────────────────

router.delete("/goals/:id", allowRoles("admin", "manager"), async (req, res) => {
  try {
    const { rows } = await db.query(
      `DELETE FROM okr_objectives
       WHERE id = $1 AND workspace_id = $2
         AND (success_measure IS NULL OR target_date IS NULL)
       RETURNING id`,
      [req.params.id, req.workspaceId]
    );
    if (!rows[0]) return res.status(404).json({ error: "Goal not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── LINK SPRINT TO GOAL ──────────────────────────────────────────────────────
/*
  POST /goals/:id/sprints
  Admin or manager only.
  After linking, goal progress is immediately recalculated from sprint completions.

  When a sprint is linked to a goal:
  • Sprint completion auto-updates goal progress
  • Goal progress = (completed linked sprints / total linked sprints) × 100
  • Manual progress updates are overridden by sprint-driven calculation
*/
router.post("/goals/:id/sprints", allowRoles("admin", "manager"), async (req, res) => {
  try {
    const { sprint_id } = req.body;
    if (!sprint_id) return res.status(400).json({ error: "sprint_id is required" });

    const { rows: goal } = await db.query(
      `SELECT id FROM okr_objectives
       WHERE id = $1 AND workspace_id = $2
         AND (success_measure IS NULL OR target_date IS NULL)`,
      [req.params.id, req.workspaceId]
    );
    if (!goal[0]) return res.status(404).json({ error: "Goal not found" });

    const { rows: sprint } = await db.query(
      "SELECT id FROM sprints WHERE id = $1 AND workspace_id = $2",
      [sprint_id, req.workspaceId]
    );
    if (!sprint[0]) return res.status(404).json({ error: "Sprint not found" });

    await db.query(
      `INSERT INTO okr_sprint_links (objective_id, sprint_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.params.id, sprint_id]
    );

    // Recalculate goal progress based on sprint completions
    await recalcGoalFromSprints(req.params.id);

    const { rows: updated } = await db.query(
      "SELECT * FROM okr_objectives WHERE id = $1",
      [req.params.id]
    );
    res.status(201).json(updated[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── UNLINK SPRINT FROM GOAL ──────────────────────────────────────────────────

router.delete("/goals/:id/sprints/:sprintId", allowRoles("admin", "manager"), async (req, res) => {
  try {
    const { rows: goal } = await db.query(
      `SELECT id FROM okr_objectives
       WHERE id = $1 AND workspace_id = $2
         AND (success_measure IS NULL OR target_date IS NULL)`,
      [req.params.id, req.workspaceId]
    );
    if (!goal[0]) return res.status(404).json({ error: "Goal not found" });

    await db.query(
      "DELETE FROM okr_sprint_links WHERE objective_id = $1 AND sprint_id = $2",
      [req.params.id, req.params.sprintId]
    );
    await recalcGoalFromSprints(req.params.id);

    const { rows: updated } = await db.query(
      "SELECT * FROM okr_objectives WHERE id = $1",
      [req.params.id]
    );
    res.json(updated[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GOAL ASSESSMENT ─────────────────────────────────────────────────────────
/*
  GET /goals/:id/assessment
  ──────────────────────────
  Intelligence assessment for a single goal.

  What the UI should show:
  ┌─────────────────────────────────────────────────────┐
  │  Goal: "Launch mobile app"          Health: 72/100  │
  │  Status: on_track   Progress: 45%                   │
  │  Expected by now: 41%  (ahead by 4%)                │
  │  Estimated completion: 2026-06-18  ✓ On time        │
  │                                                     │
  │  ⚡ Sprint Summary: 2/5 sprints completed (60% avg) │
  │                                                     │
  │  Signals:                                           │
  │  ✅ Slightly ahead of expected pace                 │
  └─────────────────────────────────────────────────────┘
*/
router.get("/goals/:id/assessment", async (req, res) => {
  try {
    const { rows: [goal] } = await db.query(
      `SELECT * FROM okr_objectives
       WHERE id = $1 AND workspace_id = $2
         AND (success_measure IS NULL OR target_date IS NULL)`,
      [req.params.id, req.workspaceId]
    );
    if (!goal) return res.status(404).json({ error: "Goal not found" });

    // Linked sprints with task counts
    const { rows: sprints } = await db.query(
      `SELECT sl.sprint_id, s.name, s.status, s.start_date, s.end_date,
              COUNT(t.id)::int                                         AS total_tasks,
              COUNT(t.id) FILTER (WHERE t.status = 'completed')::int  AS completed_tasks
       FROM okr_sprint_links sl
       JOIN sprints s ON s.id = sl.sprint_id
       LEFT JOIN tasks t ON t.sprint_id = s.id
       WHERE sl.objective_id = $1
       GROUP BY sl.sprint_id, s.name, s.status, s.start_date, s.end_date`,
      [req.params.id]
    );

    // Timeline from time_period
    const now = new Date();
    const tp  = (goal.time_period || "").toUpperCase();
    const yearStr = tp.match(/(\d{4})/);
    const year = yearStr ? parseInt(yearStr[1]) : now.getFullYear();
    let startDate, endDate;

    if      (tp.includes("Q1")) { startDate = new Date(year, 0, 1);  endDate = new Date(year, 2, 31); }
    else if (tp.includes("Q2")) { startDate = new Date(year, 3, 1);  endDate = new Date(year, 5, 30); }
    else if (tp.includes("Q3")) { startDate = new Date(year, 6, 1);  endDate = new Date(year, 8, 30); }
    else if (tp.includes("Q4")) { startDate = new Date(year, 9, 1);  endDate = new Date(year, 11, 31); }
    else if (tp.includes("H1")) { startDate = new Date(year, 0, 1);  endDate = new Date(year, 5, 30); }
    else if (tp.includes("H2")) { startDate = new Date(year, 6, 1);  endDate = new Date(year, 11, 31); }
    else                         { startDate = new Date(year, 0, 1);  endDate = new Date(year, 11, 31); }

    const totalDays      = Math.max(1, (endDate - startDate) / 86400000);
    const daysElapsed    = Math.max(0, Math.min(totalDays, (now - startDate) / 86400000));
    const daysRemaining  = Math.max(0, (endDate - now) / 86400000);
    const expectedProgress = Math.min(100, (daysElapsed / totalDays) * 100);
    const actualProgress   = Number(goal.progress) || 0;
    const progressGap      = actualProgress - expectedProgress;

    // Sprint velocity
    const completedSprints = sprints.filter(s => s.status === "completed");
    const activeSprint     = sprints.find(s => s.status === "active");
    const plannedSprints   = sprints.filter(s => s.status === "planning");

    const avgVelocity = completedSprints.length > 0
      ? completedSprints.reduce((sum, s) =>
          sum + (s.total_tasks > 0 ? s.completed_tasks / s.total_tasks : 0), 0
        ) / completedSprints.length
      : null;

    // Estimated completion
    let estimatedCompletionDate = null;
    if (actualProgress > 0 && daysElapsed > 0 && actualProgress < 100) {
      const progressPerDay = actualProgress / daysElapsed;
      estimatedCompletionDate = new Date(
        now.getTime() + ((100 - actualProgress) / progressPerDay) * 86400000
      ).toISOString().slice(0, 10);
    } else if (actualProgress >= 100) {
      estimatedCompletionDate = now.toISOString().slice(0, 10);
    }

    // Health score (0–100)
    let healthScore = 50;
    if      (progressGap >= 15)  healthScore += 25;
    else if (progressGap >= 5)   healthScore += 15;
    else if (progressGap >= -10) healthScore += 0;
    else if (progressGap >= -20) healthScore -= 15;
    else                         healthScore -= 30;

    if (avgVelocity !== null) {
      if      (avgVelocity >= 0.8) healthScore += 20;
      else if (avgVelocity >= 0.6) healthScore += 10;
      else if (avgVelocity >= 0.4) healthScore -= 10;
      else                         healthScore -= 20;
    }

    if (endDate && estimatedCompletionDate) {
      const estDate = new Date(estimatedCompletionDate);
      if (estDate <= endDate) healthScore += 10;
      else healthScore -= (estDate - endDate) / 86400000 > 30 ? 20 : 10;
    }
    healthScore = Math.max(0, Math.min(100, Math.round(healthScore)));

    // Pace label
    let paceLabel = "on_track";
    if      (actualProgress >= 100)                            paceLabel = "complete";
    else if (daysRemaining <= 0 && actualProgress < 100)       paceLabel = "overdue";
    else if (progressGap >= 10)                                paceLabel = "ahead";
    else if (progressGap < -20 || healthScore < 35)            paceLabel = "at_risk";

    // Plain-English signals for the UI
    const signals = [];
    if (actualProgress >= 100) {
      signals.push({ type: "success", message: "Goal completed — well done!" });
    } else {
      if (actualProgress === 0 && daysElapsed > 14)
        signals.push({ type: "warning", message: "No progress recorded after 2+ weeks. Link a sprint or update progress manually." });
      if (progressGap >= 15)
        signals.push({ type: "success", message: `${Math.round(progressGap)}% ahead of expected pace — great momentum!` });
      if (progressGap < -20)
        signals.push({ type: "critical", message: `Behind schedule by ${Math.round(Math.abs(progressGap))}%. Immediate attention needed.` });
      else if (progressGap < -10)
        signals.push({ type: "warning", message: `Slightly behind expected pace (gap: ${Math.round(Math.abs(progressGap))}%).` });
      if (avgVelocity !== null && avgVelocity < 0.4)
        signals.push({ type: "critical", message: `Sprint completion rate is critically low (${Math.round(avgVelocity * 100)}%). Review sprint capacity.` });
      if (estimatedCompletionDate && endDate && new Date(estimatedCompletionDate) > endDate) {
        const daysLate = Math.round((new Date(estimatedCompletionDate) - endDate) / 86400000);
        signals.push({ type: "critical", message: `At current pace, goal will complete ${daysLate} day(s) after deadline.` });
      }
      if (sprints.length === 0)
        signals.push({ type: "info", message: "No sprints linked. Link sprints for automatic progress tracking, or update progress manually." });
      if (daysRemaining < 14 && daysRemaining > 0 && actualProgress < 80)
        signals.push({ type: "critical", message: `Only ${Math.round(daysRemaining)} day(s) left with ${Math.round(100 - actualProgress)}% work remaining.` });
      if (daysRemaining <= 0 && actualProgress < 100)
        signals.push({ type: "critical", message: "Deadline has passed and goal is not yet complete." });
    }

    let confidence = "low";
    if (sprints.length >= 2 && completedSprints.length >= 1) confidence = "medium";
    if (sprints.length >= 3 && completedSprints.length >= 2) confidence = "high";

    res.json({
      goal: {
        id:          goal.id,
        title:       goal.title,
        description: goal.description,
        status:      goal.status,
        progress:    actualProgress,
        time_period: goal.time_period,
        owner_id:    goal.owner_id,
      },
      assessment: {
        healthScore,
        paceLabel,
        confidence,
        expectedProgress:        Math.round(expectedProgress * 10) / 10,
        actualProgress,
        progressGap:             Math.round(progressGap * 10) / 10,
        daysElapsed:             Math.round(daysElapsed),
        daysRemaining:           Math.round(daysRemaining),
        totalDays:               Math.round(totalDays),
        periodStart:             startDate.toISOString().slice(0, 10),
        periodEnd:               endDate.toISOString().slice(0, 10),
        estimatedCompletionDate,
        willCompleteOnTime: estimatedCompletionDate && endDate
          ? new Date(estimatedCompletionDate) <= endDate
          : null,
      },
      sprintSummary: {
        total:       sprints.length,
        completed:   completedSprints.length,
        active:      activeSprint ? 1 : 0,
        planned:     plannedSprints.length,
        /*
         * avgVelocity = average task completion rate across completed sprints (0–100 %)
         * 80+ : healthy  |  60–79 : acceptable  |  40–59 : needs attention  |  <40 : critical
         */
        avgVelocity: avgVelocity !== null ? Math.round(avgVelocity * 100) : null,
      },
      signals,
      sprints: sprints.map(s => ({
        sprint_id:       s.sprint_id,
        name:            s.name,
        status:          s.status,
        total_tasks:     s.total_tasks,
        completed_tasks: s.completed_tasks,
        completionRate:  s.total_tasks > 0 ? Math.round((s.completed_tasks / s.total_tasks) * 100) : null,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── WORKSPACE GOAL HEALTH ────────────────────────────────────────────────────
/*
  GET /goals/workspace/health
  ────────────────────────────
  Aggregated health for all goals in the workspace.
  Used by the intelligence layer, executive summary, and admin dashboards.
*/
router.get("/goals/workspace/health", allowRoles("admin", "manager"), async (req, res) => {
  try {
    const { rows: goals } = await db.query(
      `SELECT o.id, o.title, o.status, o.progress, o.time_period, o.created_at,
              u.username AS owner_name
       FROM okr_objectives o
       LEFT JOIN users u ON u.id = o.owner_id
       WHERE o.workspace_id = $1
         AND (o.success_measure IS NULL OR o.target_date IS NULL)
       ORDER BY o.created_at DESC`,
      [req.workspaceId]
    );

    if (goals.length === 0) {
      return res.json({
        totalGoals: 0, byStatus: {}, atRiskCount: 0,
        stalledCount: 0, avgProgress: 0, avgHealthScore: null,
        behindCount: 0, completedCount: 0, goalSummaries: [],
      });
    }

    const now = new Date();

    const summaries = goals.map(g => {
      const tp = (g.time_period || "").toUpperCase();
      const yearStr = tp.match(/(\d{4})/);
      const year = yearStr ? parseInt(yearStr[1]) : now.getFullYear();
      let startDate, endDate;

      if      (tp.includes("Q1")) { startDate = new Date(year, 0, 1);  endDate = new Date(year, 2, 31); }
      else if (tp.includes("Q2")) { startDate = new Date(year, 3, 1);  endDate = new Date(year, 5, 30); }
      else if (tp.includes("Q3")) { startDate = new Date(year, 6, 1);  endDate = new Date(year, 8, 30); }
      else if (tp.includes("Q4")) { startDate = new Date(year, 9, 1);  endDate = new Date(year, 11, 31); }
      else if (tp.includes("H1")) { startDate = new Date(year, 0, 1);  endDate = new Date(year, 5, 30); }
      else if (tp.includes("H2")) { startDate = new Date(year, 6, 1);  endDate = new Date(year, 11, 31); }
      else                         { startDate = new Date(year, 0, 1);  endDate = new Date(year, 11, 31); }

      const totalDays       = Math.max(1, (endDate - startDate) / 86400000);
      const daysElapsed     = Math.max(0, Math.min(totalDays, (now - startDate) / 86400000));
      const daysRemaining   = Math.max(0, (endDate - now) / 86400000);
      const expectedProgress = Math.min(100, (daysElapsed / totalDays) * 100);
      const actualProgress   = Number(g.progress) || 0;
      const progressGap      = actualProgress - expectedProgress;

      let healthScore = 50;
      if      (progressGap >= 15)  healthScore += 25;
      else if (progressGap >= 5)   healthScore += 15;
      else if (progressGap >= -10) healthScore += 0;
      else if (progressGap >= -20) healthScore -= 15;
      else                         healthScore -= 30;
      healthScore = Math.max(0, Math.min(100, Math.round(healthScore)));

      return {
        id:              g.id,
        title:           g.title,
        status:          g.status,
        progress:        actualProgress,
        expectedProgress: Math.round(expectedProgress * 10) / 10,
        progressGap:     Math.round(progressGap * 10) / 10,
        healthScore,
        daysRemaining:   Math.round(daysRemaining),
        isStalled:       actualProgress === 0 && daysElapsed > 14,
        isBehind:        progressGap < -10,
        isComplete:      actualProgress >= 100,
        time_period:     g.time_period,
        owner_name:      g.owner_name,
      };
    });

    const byStatus = {};
    for (const s of summaries) { byStatus[s.status] = (byStatus[s.status] || 0) + 1; }

    res.json({
      totalGoals:    goals.length,
      byStatus,
      atRiskCount:   summaries.filter(s => s.status === "at_risk" || s.status === "off_track").length,
      stalledCount:  summaries.filter(s => s.isStalled).length,
      behindCount:   summaries.filter(s => s.isBehind).length,
      completedCount: summaries.filter(s => s.isComplete).length,
      avgProgress:   Math.round(summaries.reduce((a, s) => a + s.progress, 0) / summaries.length),
      avgHealthScore: Math.round(summaries.reduce((a, s) => a + s.healthScore, 0) / summaries.length),
      goalSummaries: summaries,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
