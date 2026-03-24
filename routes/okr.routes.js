// routes/okr.routes.js
import express from "express";
import db from "../db.js";
import { logAudit } from "../services/audit.service.js";
import { allowRoles } from "../middleware/role.middleware.js";
import { recalcObjectiveFromSprints } from "../services/sprint.service.js";

const router = express.Router();

// ─── OBJECTIVES ───────────────────────────────────────────────────────────────

router.get("/objectives", async (req, res) => {
  try {
    const { timePeriod, ownerId } = req.query;
    const conditions = ["o.workspace_id = $1"];
    const params = [req.workspaceId];
    let i = 2;

    if (timePeriod) { conditions.push(`o.time_period = $${i++}`); params.push(timePeriod); }
    if (ownerId)    { conditions.push(`o.owner_id = $${i++}`);    params.push(ownerId); }

    const rows = await db.query(
      `SELECT o.*, u.username AS owner_name,
              (SELECT json_agg(kr ORDER BY kr.created_at)
               FROM okr_key_results kr WHERE kr.objective_id = o.id) AS key_results,
              (SELECT json_agg(
                        json_build_object(
                          'sprint_id', sl.sprint_id,
                          'sprint_name', s.name,
                          'sprint_status', s.status,
                          'project_name', p.name,
                          'is_hidden', s.is_hidden
                        ) ORDER BY s.created_at
                      )
               FROM okr_sprint_links sl
               JOIN sprints s ON s.id = sl.sprint_id
               JOIN projects p ON p.id = s.project_id
               WHERE sl.objective_id = o.id) AS linked_sprints
       FROM okr_objectives o
       LEFT JOIN users u ON u.id = o.owner_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY o.created_at DESC`,
      params
    );
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/objectives", async (req, res) => {
  try {
    const { title, description, time_period, owner_id, parent_id } = req.body;
    if (!title || !time_period) return res.status(400).json({ error: "title and time_period are required" });

    const row = await db.query(
      `INSERT INTO okr_objectives (workspace_id, owner_id, title, description, time_period, parent_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.workspaceId, owner_id || req.user.id, title, description || null, time_period, parent_id || null]
    );
    await logAudit({ workspaceId: req.workspaceId, userId: req.user.id, action: "okr.objective.create", entityType: "okr_objective", entityId: row.rows[0].id, newValue: { title } });
    res.status(201).json(row.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/objectives/:id", async (req, res) => {
  try {
    const { title, description, time_period, status, progress, owner_id } = req.body;
    const row = await db.query(
      `UPDATE okr_objectives SET
         title       = COALESCE($1, title),
         description = COALESCE($2, description),
         time_period = COALESCE($3, time_period),
         status      = COALESCE($4, status),
         progress    = COALESCE($5, progress),
         owner_id    = COALESCE($6, owner_id),
         updated_at  = NOW()
       WHERE id = $7 AND workspace_id = $8 RETURNING *`,
      [title, description, time_period, status, progress, owner_id, req.params.id, req.workspaceId]
    );
    res.json(row.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/objectives/:id", async (req, res) => {
  try {
    await db.query("DELETE FROM okr_objectives WHERE id = $1 AND workspace_id = $2", [req.params.id, req.workspaceId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SPRINT LINKS ─────────────────────────────────────────────────────────────

/* Link a sprint to an objective (admin only).
   After linking, immediately recalculate the objective's progress. */
router.post("/objectives/:id/sprint-links", allowRoles("admin"), async (req, res) => {
  try {
    const { sprint_id } = req.body;
    if (!sprint_id) return res.status(400).json({ error: "sprint_id is required" });

    // Verify objective belongs to this workspace
    const { rows: obj } = await db.query(
      "SELECT id FROM okr_objectives WHERE id = $1 AND workspace_id = $2",
      [req.params.id, req.workspaceId]
    );
    if (!obj[0]) return res.status(404).json({ error: "Objective not found" });

    // Verify sprint belongs to this workspace
    const { rows: sprint } = await db.query(
      "SELECT id FROM sprints WHERE id = $1 AND workspace_id = $2",
      [sprint_id, req.workspaceId]
    );
    if (!sprint[0]) return res.status(404).json({ error: "Sprint not found" });

    await db.query(
      `INSERT INTO okr_sprint_links (objective_id, sprint_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.params.id, sprint_id]
    );

    // Recalculate progress now that a new sprint is linked
    await recalcObjectiveFromSprints(req.params.id);

    const { rows: updated } = await db.query(
      "SELECT * FROM okr_objectives WHERE id = $1",
      [req.params.id]
    );
    res.status(201).json(updated[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* Unlink a sprint from an objective (admin only). */
router.delete("/objectives/:id/sprint-links/:sprintId", allowRoles("admin"), async (req, res) => {
  try {
    await db.query(
      "DELETE FROM okr_sprint_links WHERE objective_id = $1 AND sprint_id = $2",
      [req.params.id, req.params.sprintId]
    );

    // Recalculate after unlinking
    await recalcObjectiveFromSprints(req.params.id);

    const { rows: updated } = await db.query(
      "SELECT * FROM okr_objectives WHERE id = $1",
      [req.params.id]
    );
    res.json(updated[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── KEY RESULTS ──────────────────────────────────────────────────────────────

router.post("/objectives/:objectiveId/key-results", async (req, res) => {
  try {
    const { title, type = "number", start_value = 0, target_value, current_value = 0, unit, due_date, owner_id } = req.body;
    if (!title || target_value === undefined) return res.status(400).json({ error: "title and target_value are required" });

    const row = await db.query(
      `INSERT INTO okr_key_results
         (objective_id, title, owner_id, type, start_value, target_value, current_value, unit, due_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.params.objectiveId, title, owner_id || req.user.id, type, start_value, target_value, current_value, unit || null, due_date || null]
    );
    res.status(201).json(row.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/key-results/:id", async (req, res) => {
  try {
    const { title, current_value, status, due_date } = req.body;
    const row = await db.query(
      `UPDATE okr_key_results SET
         title         = COALESCE($1, title),
         current_value = COALESCE($2, current_value),
         status        = COALESCE($3, status),
         due_date      = COALESCE($4, due_date),
         updated_at    = NOW()
       WHERE id = $5 RETURNING *`,
      [title, current_value, status, due_date, req.params.id]
    );

    // Auto-recalculate parent objective progress from KRs
    // (only when objective has no linked sprints — sprints take priority)
    if (row.rows[0]) {
      const kr = row.rows[0];

      const { rows: sprintLinks } = await db.query(
        "SELECT id FROM okr_sprint_links WHERE objective_id = $1 LIMIT 1",
        [kr.objective_id]
      );

      if (sprintLinks.length === 0) {
        // No sprint links — calculate from KRs as before
        const allKRs = await db.query(
          "SELECT * FROM okr_key_results WHERE objective_id = $1",
          [kr.objective_id]
        );
        const krs = allKRs.rows;
        const totalProgress = krs.reduce((acc, k) => {
          const range = Number(k.target_value) - Number(k.start_value);
          if (range <= 0) return acc;
          const pct = Math.min(100, ((Number(k.current_value) - Number(k.start_value)) / range) * 100);
          return acc + pct;
        }, 0);
        const avgProgress = krs.length > 0 ? totalProgress / krs.length : 0;

        await db.query(
          "UPDATE okr_objectives SET progress = $1, updated_at = NOW() WHERE id = $2",
          [Math.round(avgProgress * 100) / 100, kr.objective_id]
        );
      }
      // If sprint links exist, sprint completion drives progress — don't override
    }

    res.json(row.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/key-results/:id", async (req, res) => {
  try {
    await db.query("DELETE FROM okr_key_results WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── OKR ASSESSMENT ───────────────────────────────────────────────────────────
/*
  GET /objectives/:id/assessment
  ─────────────────────────────
  Returns a full health assessment for a single OKR objective.

  What it tells you:
  • healthScore (0–100)      — how healthy this OKR is right now
  • paceLabel                — "ahead" | "on_track" | "at_risk" | "overdue" | "complete"
  • progressGap              — actual progress minus expected-by-now progress
  • estimatedCompletionDate  — at current pace, when will it reach 100%?
  • willCompleteOnTime       — boolean prediction
  • signals                  — human-readable warnings/successes (critical/warning/info/success)
  • sprintSummary            — velocity from linked sprints
  • keyResults               — per-KR progress vs expected pace, at-risk flag
*/
router.get("/objectives/:id/assessment", async (req, res) => {
  try {
    // 1. Objective
    const { rows: [objective] } = await db.query(
      `SELECT * FROM okr_objectives WHERE id = $1 AND workspace_id = $2`,
      [req.params.id, req.workspaceId]
    );
    if (!objective) return res.status(404).json({ error: "Objective not found" });

    // 2. Key Results
    const { rows: keyResults } = await db.query(
      `SELECT * FROM okr_key_results WHERE objective_id = $1 ORDER BY created_at`,
      [req.params.id]
    );

    // 3. Linked sprints with task counts
    const { rows: sprints } = await db.query(
      `SELECT sl.sprint_id, s.name, s.status, s.start_date, s.end_date,
              COUNT(t.id)::int                                          AS total_tasks,
              COUNT(t.id) FILTER (WHERE t.status = 'completed')::int   AS completed_tasks
       FROM okr_sprint_links sl
       JOIN sprints s ON s.id = sl.sprint_id
       LEFT JOIN tasks t ON t.sprint_id = s.id
       WHERE sl.objective_id = $1
       GROUP BY sl.sprint_id, s.name, s.status, s.start_date, s.end_date`,
      [req.params.id]
    );

    // 4. Timeline — parse time_period (e.g. "2026-Q1", "2026-H2", "2026")
    const now = new Date();
    let startDate, endDate;

    const tp = (objective.time_period || "").toUpperCase();
    const yearStr = tp.match(/(\d{4})/);
    const year = yearStr ? parseInt(yearStr[1]) : now.getFullYear();

    if      (tp.includes("Q1")) { startDate = new Date(year, 0, 1);  endDate = new Date(year, 2, 31); }
    else if (tp.includes("Q2")) { startDate = new Date(year, 3, 1);  endDate = new Date(year, 5, 30); }
    else if (tp.includes("Q3")) { startDate = new Date(year, 6, 1);  endDate = new Date(year, 8, 30); }
    else if (tp.includes("Q4")) { startDate = new Date(year, 9, 1);  endDate = new Date(year, 11, 31); }
    else if (tp.includes("H1")) { startDate = new Date(year, 0, 1);  endDate = new Date(year, 5, 30); }
    else if (tp.includes("H2")) { startDate = new Date(year, 6, 1);  endDate = new Date(year, 11, 31); }
    else                         { startDate = new Date(year, 0, 1);  endDate = new Date(year, 11, 31); }

    const totalDays     = Math.max(1, (endDate - startDate) / 86400000);
    const daysElapsed   = Math.max(0, Math.min(totalDays, (now - startDate) / 86400000));
    const daysRemaining = Math.max(0, (endDate - now) / 86400000);
    const expectedProgress = Math.min(100, (daysElapsed / totalDays) * 100);
    const actualProgress   = Number(objective.progress) || 0;
    const progressGap      = actualProgress - expectedProgress;

    // 5. Sprint velocity analysis
    const completedSprints = sprints.filter(s => s.status === "completed");
    const activeSprint     = sprints.find(s => s.status === "active");
    const plannedSprints   = sprints.filter(s => s.status === "planning");

    const avgVelocity = completedSprints.length > 0
      ? completedSprints.reduce((sum, s) =>
          sum + (s.total_tasks > 0 ? s.completed_tasks / s.total_tasks : 0), 0
        ) / completedSprints.length
      : null;

    // 6. Estimated completion date at current pace
    let estimatedCompletionDate = null;
    if (actualProgress > 0 && daysElapsed > 0 && actualProgress < 100) {
      const progressPerDay  = actualProgress / daysElapsed;
      const daysToComplete  = (100 - actualProgress) / progressPerDay;
      estimatedCompletionDate = new Date(now.getTime() + daysToComplete * 86400000).toISOString().slice(0, 10);
    } else if (actualProgress >= 100) {
      estimatedCompletionDate = now.toISOString().slice(0, 10);
    }

    // 7. Health score (0–100)
    //    Base: 50. Adjust for pace gap, sprint velocity, deadline feasibility.
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
      else {
        const daysLate = (estDate - endDate) / 86400000;
        healthScore -= daysLate > 30 ? 20 : 10;
      }
    }
    healthScore = Math.max(0, Math.min(100, Math.round(healthScore)));

    // 8. Pace label
    let paceLabel = "on_track";
    if (actualProgress >= 100)                       paceLabel = "complete";
    else if (daysRemaining <= 0 && actualProgress < 100) paceLabel = "overdue";
    else if (progressGap >= 10)                      paceLabel = "ahead";
    else if (progressGap < -20 || healthScore < 35)  paceLabel = "at_risk";

    // 9. Signals — human-readable, UI-ready
    const signals = [];
    if (actualProgress >= 100) {
      signals.push({ type: "success", message: "Objective completed — well done!" });
    } else {
      if (actualProgress === 0 && daysElapsed > 14)
        signals.push({ type: "warning", message: "No progress recorded after 2+ weeks. Consider updating key results or linking a sprint." });
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
        signals.push({ type: "critical", message: `At current pace, objective will complete ${daysLate} day(s) after deadline.` });
      }
      if (sprints.length === 0)
        signals.push({ type: "info", message: "No sprints linked. Progress is tracked via key results only. Link sprints for richer forecasting." });
      if (daysRemaining < 14 && daysRemaining > 0 && actualProgress < 80)
        signals.push({ type: "critical", message: `Only ${Math.round(daysRemaining)} day(s) left with ${100 - actualProgress}% work remaining.` });
      if (daysRemaining <= 0 && actualProgress < 100)
        signals.push({ type: "critical", message: "Deadline has passed and objective is not yet complete." });
    }

    // 10. Confidence in the forecast
    let confidence = "low";
    if (sprints.length >= 2 && completedSprints.length >= 1) confidence = "medium";
    if (sprints.length >= 3 && completedSprints.length >= 2) confidence = "high";

    // 11. Per-KR assessment
    const krAssessment = keyResults.map(kr => {
      const range      = Number(kr.target_value) - Number(kr.start_value);
      const krProgress = range > 0
        ? Math.min(100, ((Number(kr.current_value) - Number(kr.start_value)) / range) * 100)
        : 0;
      const isAtRisk = krProgress < expectedProgress - 10;
      return {
        id:              kr.id,
        title:           kr.title,
        current_value:   kr.current_value,
        target_value:    kr.target_value,
        unit:            kr.unit,
        status:          kr.status,
        progress:        Math.round(krProgress * 10) / 10,
        expectedProgress: Math.round(expectedProgress * 10) / 10,
        isAtRisk,
        progressGap:     Math.round((krProgress - expectedProgress) * 10) / 10,
      };
    });

    res.json({
      /*
       * WHAT THIS SECTION MEANS:
       * objective    — the raw OKR record (title, status, progress, time_period)
       * assessment   — the core intelligence: is this OKR healthy? will it finish on time?
       * sprintSummary — sprint-based execution metrics linked to this OKR
       * keyResults   — per-KR progress vs expected pace, with at-risk flag
       * signals      — plain-English warnings/successes for the UI to display as banners/tags
       */
      objective: {
        id:           objective.id,
        title:        objective.title,
        status:       objective.status,
        progress:     actualProgress,
        time_period:  objective.time_period,
        owner_id:     objective.owner_id,
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
        willCompleteOnTime:      estimatedCompletionDate && endDate
                                   ? new Date(estimatedCompletionDate) <= endDate
                                   : null,
      },
      sprintSummary: {
        total:       sprints.length,
        completed:   completedSprints.length,
        active:      activeSprint ? 1 : 0,
        planned:     plannedSprints.length,
        avgVelocity: avgVelocity !== null ? Math.round(avgVelocity * 100) : null,
        /*
         * avgVelocity = average task completion rate across completed sprints (0–100 %)
         * 80+ = healthy, 60–79 = acceptable, 40–59 = needs attention, <40 = critical
         */
      },
      keyResults: krAssessment,
      signals,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── WORKSPACE OKR HEALTH ─────────────────────────────────────────────────────
/*
  GET /objectives/workspace/health
  ─────────────────────────────────
  Aggregated OKR health for the entire workspace.
  Used by the intelligence layer (executive summary, signal detector).

  Returns:
  • totalObjectives        — all objectives in this workspace
  • byStatus               — count per status bucket
  • atRiskCount            — objectives with status "at_risk" or "off_track"
  • stalledCount           — objectives with 0% progress after 14+ days
  • avgProgress            — mean progress across all objectives
  • avgHealthScore         — estimated health (progress vs expected pace)
  • behindCount            — objectives where actual progress < expected by >10%
  • completedCount         — objectives at 100%
  • objectiveSummaries     — lightweight list for UI dashboards
*/
router.get("/objectives/workspace/health", async (req, res) => {
  try {
    const { rows: objectives } = await db.query(
      `SELECT o.*, u.username AS owner_name
       FROM okr_objectives o
       LEFT JOIN users u ON u.id = o.owner_id
       WHERE o.workspace_id = $1
       ORDER BY o.created_at DESC`,
      [req.workspaceId]
    );

    if (objectives.length === 0) {
      return res.json({
        totalObjectives: 0,
        byStatus: {},
        atRiskCount: 0,
        stalledCount: 0,
        avgProgress: 0,
        avgHealthScore: null,
        behindCount: 0,
        completedCount: 0,
        objectiveSummaries: [],
      });
    }

    const now = new Date();

    const summaries = objectives.map(obj => {
      const tp = (obj.time_period || "").toUpperCase();
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
      const actualProgress   = Number(obj.progress) || 0;
      const progressGap      = actualProgress - expectedProgress;

      // simple health score
      let healthScore = 50;
      if      (progressGap >= 15)  healthScore += 25;
      else if (progressGap >= 5)   healthScore += 15;
      else if (progressGap >= -10) healthScore += 0;
      else if (progressGap >= -20) healthScore -= 15;
      else                         healthScore -= 30;
      healthScore = Math.max(0, Math.min(100, Math.round(healthScore)));

      const isStalled  = actualProgress === 0 && daysElapsed > 14;
      const isBehind   = progressGap < -10;
      const isComplete = actualProgress >= 100;

      return {
        id:              obj.id,
        title:           obj.title,
        status:          obj.status,
        progress:        actualProgress,
        expectedProgress: Math.round(expectedProgress * 10) / 10,
        progressGap:     Math.round(progressGap * 10) / 10,
        healthScore,
        daysRemaining:   Math.round(daysRemaining),
        isStalled,
        isBehind,
        isComplete,
        time_period:     obj.time_period,
        owner_name:      obj.owner_name,
      };
    });

    // Aggregates
    const byStatus = {};
    for (const s of summaries) {
      byStatus[s.status] = (byStatus[s.status] || 0) + 1;
    }

    const atRiskCount   = summaries.filter(s => s.status === "at_risk" || s.status === "off_track").length;
    const stalledCount  = summaries.filter(s => s.isStalled).length;
    const behindCount   = summaries.filter(s => s.isBehind).length;
    const completedCount = summaries.filter(s => s.isComplete).length;
    const avgProgress   = Math.round(summaries.reduce((a, s) => a + s.progress, 0) / summaries.length);
    const avgHealthScore = Math.round(summaries.reduce((a, s) => a + s.healthScore, 0) / summaries.length);

    res.json({
      totalObjectives: objectives.length,
      byStatus,
      atRiskCount,
      stalledCount,
      avgProgress,
      avgHealthScore,
      behindCount,
      completedCount,
      objectiveSummaries: summaries,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
