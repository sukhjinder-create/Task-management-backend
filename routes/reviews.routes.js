// routes/reviews.routes.js
import express from "express";
import db from "../db.js";
import { logAudit } from "../services/audit.service.js";
import { sendPerformanceReviewEmail } from "../services/email.service.js";
import { autoAssignReviews, getQuarterInfo } from "../cron/reviews.cron.js";
import { notifyUser } from "../services/notification.service.js";
import { queueImpactedIntelligenceRecalculation } from "../intelligence/realtime/recalculation.service.js";

const router = express.Router();

// ─── REVIEW CYCLES ────────────────────────────────────────────────────────────

router.get("/cycles", async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT rc.*,
              (SELECT COUNT(*) FROM performance_reviews WHERE cycle_id = rc.id) AS review_count,
              (SELECT COUNT(*) FROM performance_reviews WHERE cycle_id = rc.id AND status = 'submitted') AS submitted_count
       FROM review_cycles rc
       WHERE rc.workspace_id = $1
       ORDER BY rc.start_date DESC`,
      [req.workspaceId]
    );
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/cycles", async (req, res) => {
  try {
    if (!["admin", "owner"].includes(req.user.role)) return res.status(403).json({ error: "Admin required" });
    const { name, type = "quarterly", start_date, end_date } = req.body;
    if (!name || !start_date || !end_date) return res.status(400).json({ error: "name, start_date, end_date required" });

    const row = await db.query(
      `INSERT INTO review_cycles (workspace_id, name, type, start_date, end_date)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.workspaceId, name, type, start_date, end_date]
    );
    const cycle = row.rows[0];
    logAudit({
      workspaceId: req.workspaceId, userId: req.user.id,
      action: "review_cycle.create", entityType: "review_cycle", entityId: cycle.id,
      newValue: { name: cycle.name, type: cycle.type, start_date: cycle.start_date, end_date: cycle.end_date },
    });
    res.status(201).json(cycle);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Change cycle status; when activating, auto-assign reviews */
router.patch("/cycles/:id/status", async (req, res) => {
  try {
    if (!["admin", "owner"].includes(req.user.role)) return res.status(403).json({ error: "Admin required" });
    const { status } = req.body;
    if (!["draft", "active", "completed"].includes(status)) return res.status(400).json({ error: "Invalid status" });

    const row = await db.query(
      `UPDATE review_cycles SET status = $1 WHERE id = $2 AND workspace_id = $3 RETURNING *`,
      [status, req.params.id, req.workspaceId]
    );
    const cycle = row.rows[0];
    if (!cycle) return res.status(404).json({ error: "Cycle not found" });

    if (status === "active") {
      autoAssignReviews(cycle.id, req.workspaceId).catch(err =>
        console.error("[reviews] Auto-assign error:", err.message)
      );
    }

    logAudit({
      workspaceId: req.workspaceId, userId: req.user.id,
      action: "review_cycle.status_change", entityType: "review_cycle", entityId: cycle.id,
      newValue: { status, cycle_name: cycle.name },
    });
    res.json(cycle);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Admin: manually trigger current-quarter cycle (create + activate + assign) */
router.post("/trigger-quarter", async (req, res) => {
  try {
    if (!["admin", "owner"].includes(req.user.role)) return res.status(403).json({ error: "Admin required" });

    const q = getQuarterInfo();

    const existing = await db.query(
      `SELECT id FROM review_cycles WHERE workspace_id = $1 AND name = $2`,
      [req.workspaceId, q.name]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: `Cycle "${q.name}" already exists` });
    }

    const { rows } = await db.query(
      `INSERT INTO review_cycles
         (workspace_id, name, type, start_date, end_date, status, auto_generated)
       VALUES ($1,$2,$3,$4,$5,'active',true)
       RETURNING *`,
      [req.workspaceId, q.name, q.type, q.startStr, q.endStr]
    );

    const cycle = rows[0];
    const reviewerCount = await autoAssignReviews(cycle.id, req.workspaceId);

    logAudit({
      workspaceId: req.workspaceId, userId: req.user.id,
      action: "review_cycle.trigger_quarter", entityType: "review_cycle", entityId: cycle.id,
      newValue: { name: cycle.name, reviewerCount, start_date: cycle.start_date, end_date: cycle.end_date },
    });
    res.status(201).json({ cycle, reviewerCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── REVIEWS ──────────────────────────────────────────────────────────────────

router.get("/cycles/:cycleId/reviews", async (req, res) => {
  try {
    const isAdmin = ["admin", "owner"].includes(req.user.role);
    let query = `
      SELECT pr.*,
             rv.username AS reviewee_name, rv.email AS reviewee_email,
             rr.username AS reviewer_name
      FROM performance_reviews pr
      JOIN users rv ON rv.id = pr.reviewee_id
      JOIN users rr ON rr.id = pr.reviewer_id
      WHERE pr.cycle_id = $1
        AND pr.type IN ('self','manager')`;
    const params = [req.params.cycleId];

    if (!isAdmin) {
      query += ` AND (pr.reviewee_id = $2 OR pr.reviewer_id = $2)`;
      params.push(req.user.id);
    }
    query += " ORDER BY rv.username";

    const rows = await db.query(query, params);
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** All pending/in-progress reviews assigned to ME (across all active cycles) */
router.get("/pending", async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT pr.*,
              rv.username AS reviewee_name,
              rc.name AS cycle_name, rc.end_date AS cycle_end_date, rc.status AS cycle_status,
              -- For manager reviews: include self-review status and content so UI can show lock state
              CASE WHEN pr.type = 'manager' THEN
                (SELECT json_build_object(
                  'status', sr.status,
                  'overall_score', CASE WHEN sr.status = 'submitted' THEN sr.overall_score ELSE NULL END,
                  'strengths',     CASE WHEN sr.status = 'submitted' THEN sr.strengths     ELSE NULL END,
                  'improvements',  CASE WHEN sr.status = 'submitted' THEN sr.improvements  ELSE NULL END,
                  'goals_next',    CASE WHEN sr.status = 'submitted' THEN sr.goals_next    ELSE NULL END,
                  'submitted_at',  sr.submitted_at
                ) FROM performance_reviews sr
                WHERE sr.cycle_id = pr.cycle_id
                  AND sr.reviewee_id = pr.reviewee_id
                  AND sr.type = 'self'
                LIMIT 1)
              ELSE NULL END AS self_review_data
       FROM performance_reviews pr
       JOIN users rv ON rv.id = pr.reviewee_id
       JOIN review_cycles rc ON rc.id = pr.cycle_id
       WHERE pr.reviewer_id = $1
         AND pr.status != 'submitted'
         AND rc.workspace_id = $2
         AND rc.status = 'active'
         AND pr.type IN ('self','manager')
       ORDER BY rc.end_date ASC, rv.username`,
      [req.user.id, req.workspaceId]
    );
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** All submitted/missed reviews ABOUT ME (across all cycles) */
router.get("/about-me", async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT pr.*,
              rr.username AS reviewer_name,
              rc.name AS cycle_name, rc.end_date AS cycle_end_date, rc.status AS cycle_status
       FROM performance_reviews pr
       JOIN users rr ON rr.id = pr.reviewer_id
       JOIN review_cycles rc ON rc.id = pr.cycle_id
       WHERE pr.reviewee_id = $1
         AND pr.status IN ('submitted','missed')
         AND pr.type IN ('self','manager')
         AND rc.workspace_id = $2
       ORDER BY rc.end_date DESC`,
      [req.user.id, req.workspaceId]
    );
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Manager's view of their direct reports' self-review progress.
 * Available to any authenticated user — isManager is determined by whether
 * they have direct reports, not by their admin role.
 */
router.get("/my-team-progress", async (req, res) => {
  try {
    // Find the most recent active cycle
    const cycleRes = await db.query(
      `SELECT id, name, end_date
       FROM review_cycles
       WHERE workspace_id = $1 AND status = 'active'
       ORDER BY start_date DESC
       LIMIT 1`,
      [req.workspaceId]
    );
    const cycle = cycleRes.rows[0] || null;

    // Find direct reports of the current user
    const reportsRes = await db.query(
      `SELECT wu.user_id, u.username, u.email
       FROM workspace_users wu
       JOIN users u ON u.id = wu.user_id
       WHERE wu.workspace_id = $1
         AND wu.manager_id = $2
       ORDER BY u.username`,
      [req.workspaceId, req.user.id]
    );

    if (reportsRes.rows.length === 0) {
      return res.json({ cycle, team: [] });
    }

    if (!cycle) {
      return res.json({
        cycle: null,
        team: reportsRes.rows.map(m => ({
          user_id: m.user_id, username: m.username, email: m.email,
          self_review: null, manager_review: null,
        })),
      });
    }

    const directReportIds = reportsRes.rows.map(r => r.user_id);

    // Fetch self-reviews and this manager's reviews for each direct report
    const reviewsRes = await db.query(
      `SELECT pr.id, pr.cycle_id, pr.reviewee_id, pr.reviewer_id,
              pr.type, pr.status, pr.overall_score,
              pr.strengths, pr.improvements, pr.goals_next, pr.submitted_at
       FROM performance_reviews pr
       WHERE pr.cycle_id = $1
         AND pr.reviewee_id = ANY($2::uuid[])
         AND (
           (pr.type = 'self')
           OR (pr.type = 'manager' AND pr.reviewer_id = $3)
         )`,
      [cycle.id, directReportIds, req.user.id]
    );

    // Build per-member map
    const memberMap = {};
    for (const m of reportsRes.rows) {
      memberMap[m.user_id] = {
        user_id: m.user_id, username: m.username, email: m.email,
        self_review: null, manager_review: null,
      };
    }

    for (const pr of reviewsRes.rows) {
      const entry = memberMap[pr.reviewee_id];
      if (!entry) continue;

      if (pr.type === "self") {
        entry.self_review = {
          id:            pr.id,
          status:        pr.status,
          overall_score: pr.status === "submitted" ? pr.overall_score : null,
          strengths:     pr.status === "submitted" ? pr.strengths     : null,
          improvements:  pr.status === "submitted" ? pr.improvements  : null,
          goals_next:    pr.status === "submitted" ? pr.goals_next    : null,
          submitted_at:  pr.submitted_at,
        };
      } else if (pr.type === "manager") {
        entry.manager_review = {
          id:           pr.id,
          status:       pr.status,
          locked:       true, // computed in second pass below
          overall_score: pr.overall_score,
          submitted_at:  pr.submitted_at,
        };
      }
    }

    // Second pass: set locked correctly once self_review is populated
    for (const entry of Object.values(memberMap)) {
      if (entry.manager_review) {
        entry.manager_review.locked = entry.self_review?.status !== "submitted";
      }
    }

    res.json({ cycle, team: Object.values(memberMap) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Latest intelligence context for a reviewee (shown in review form) */
router.get("/user-context/:userId", async (req, res) => {
  if (req.user.role === "user" && req.user.id !== req.params.userId) {
    return res.status(403).json({ error: "Not allowed" });
  }
  try {
    const rows = await db.query(
      `SELECT
         to_char(last_evaluated_at, 'YYYY-MM') AS month,
         score,
         jsonb_build_object(
           'executionReliability', dimensions->'executionReliability'->>'score',
           'deliveryEffectiveness', dimensions->'deliveryEffectiveness'->>'score',
           'collaborationHealth', dimensions->'collaborationHealth'->>'score',
           'workSustainability', dimensions->'workSustainability'->>'score',
           'professionalDiscipline', dimensions->'professionalDiscipline'->>'score',
           'attendanceScore', attendance->>'score'
         ) AS breakdown
       FROM user_intelligence
       WHERE workspace_id = $1 AND user_id = $2
       ORDER BY last_evaluated_at DESC LIMIT 1`,
      [req.workspaceId, req.params.userId]
    );
    res.json(rows.rows[0] ? { ...rows.rows[0], scoreSource: "enterprise_intelligence" } : null);
  } catch (err) {
    const status = err?.code === "42P01" ? 503 : 500;
    res.status(status).json({ error: err.message });
  }
});

/**
 * For a manager review form: fetch the reviewee's submitted self-review content.
 * Only the assigned reviewer (or admin) may call this.
 */
router.get("/reviews/:reviewId/self-review-context", async (req, res) => {
  try {
    const reviewRes = await db.query(
      `SELECT reviewee_id, cycle_id, type, reviewer_id
       FROM performance_reviews WHERE id = $1`,
      [req.params.reviewId]
    );
    const managerReview = reviewRes.rows[0];
    if (!managerReview) return res.status(404).json({ error: "Review not found" });

    const isAdmin = ["admin", "owner"].includes(req.user.role);
    if (!isAdmin && managerReview.reviewer_id !== req.user.id) {
      return res.status(403).json({ error: "Access denied" });
    }
    if (managerReview.type !== "manager") {
      return res.status(400).json({ error: "Only applicable to manager reviews" });
    }

    const selfRes = await db.query(
      `SELECT overall_score, strengths, improvements, goals_next, status, submitted_at
       FROM performance_reviews
       WHERE cycle_id = $1 AND reviewee_id = $2 AND type = 'self' AND status = 'submitted'
       LIMIT 1`,
      [managerReview.cycle_id, managerReview.reviewee_id]
    );
    res.json(selfRes.rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Create a review request (manual admin assignment) */
router.post("/cycles/:cycleId/reviews", async (req, res) => {
  try {
    if (!["admin", "owner"].includes(req.user.role)) return res.status(403).json({ error: "Admin required" });
    const { reviewee_id, reviewer_id, type = "manager" } = req.body;
    if (!reviewee_id || !reviewer_id) return res.status(400).json({ error: "reviewee_id and reviewer_id required" });
    if (!["self", "manager"].includes(type)) return res.status(400).json({ error: "type must be self or manager" });

    const row = await db.query(
      `INSERT INTO performance_reviews (cycle_id, reviewee_id, reviewer_id, type)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (cycle_id, reviewee_id, reviewer_id, type) DO NOTHING
       RETURNING *`,
      [req.params.cycleId, reviewee_id, reviewer_id, type]
    );

    const [cycleRow, revieweeRow, reviewerRow] = await Promise.all([
      db.query("SELECT name, end_date FROM review_cycles WHERE id = $1", [req.params.cycleId]),
      db.query("SELECT email, username FROM users WHERE id = $1", [reviewee_id]),
      db.query("SELECT email, username FROM users WHERE id = $1", [reviewer_id]),
    ]);

    const cycle = cycleRow.rows[0];
    const reviewer = reviewerRow.rows[0];

    if (reviewer?.email) {
      sendPerformanceReviewEmail({
        to: reviewer.email,
        username: reviewer.username,
        reviewerName: revieweeRow.rows[0]?.username,
        cycleName: cycle?.name,
        dueDate: cycle?.end_date,
        reviewUrl: `${process.env.FRONTEND_URL || "http://localhost:5173"}/reviews`,
      }).catch(() => {});
    }

    res.status(201).json(row.rows[0] || { message: "Review already exists" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Submit or update a review.
 *
 * Side-effects when status becomes 'submitted':
 *  - Self-review submitted → guarantee manager review row exists + notify manager
 *  - Any review submitted  → check if ALL reviews in cycle are done → auto-complete cycle
 *
 * Manager reviews are locked (HTTP 423) until the employee's self-review is submitted.
 */
router.put("/reviews/:reviewId", async (req, res) => {
  try {
    const { overall_score, strengths, improvements, goals_next, answers, status } = req.body;

    const existing = await db.query(
      "SELECT * FROM performance_reviews WHERE id = $1",
      [req.params.reviewId]
    );
    const review = existing.rows[0];
    if (!review) return res.status(404).json({ error: "Review not found" });

    const isAdmin = ["admin", "owner"].includes(req.user.role);
    const isOwner = review.reviewer_id === req.user.id;
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: "Access denied" });
    }

    // Manager reviews are locked until the employee's self-review is submitted
    if (review.type === "manager") {
      const selfCheck = await db.query(
        `SELECT status FROM performance_reviews
         WHERE cycle_id = $1 AND reviewee_id = $2 AND type = 'self'
         LIMIT 1`,
        [review.cycle_id, review.reviewee_id]
      );
      const selfReview = selfCheck.rows[0];
      if (!selfReview || selfReview.status !== "submitted") {
        return res.status(423).json({
          error: "Manager review is locked until the employee submits their self-review first",
        });
      }
    }

    const newStatus = status === "submitted"
      ? "submitted"
      : (review.status === "submitted" ? "submitted" : "in_progress");

    const row = await db.query(
      `UPDATE performance_reviews SET
         overall_score = COALESCE($1, overall_score),
         strengths     = COALESCE($2, strengths),
         improvements  = COALESCE($3, improvements),
         goals_next    = COALESCE($4, goals_next),
         answers       = COALESCE($5::jsonb, answers),
         status        = $6,
         submitted_at  = CASE WHEN $6 = 'submitted' THEN NOW() ELSE submitted_at END,
         updated_at    = NOW()
       WHERE id = $7 RETURNING *`,
      [overall_score, strengths, improvements, goals_next,
       answers ? JSON.stringify(answers) : null, newStatus, req.params.reviewId]
    );

    logAudit({
      workspaceId: req.workspaceId, userId: req.user.id,
      action: "review.submit", entityType: "review", entityId: req.params.reviewId,
      newValue: { type: review.type, status: newStatus },
    });

    // ── Side-effects (fire-and-forget, never fail the response) ───────────────
    handleReviewSubmissionSideEffects({
      review,
      newStatus,
      workspaceId: req.workspaceId,
    }).catch((err) => console.error("[reviews] Side-effect error:", err.message));

    if (newStatus === "submitted" && review.status !== "submitted") {
      queueImpactedIntelligenceRecalculation({
        workspaceId: req.workspaceId,
        reason: "review_submitted",
        userIds: [review.reviewee_id, review.reviewer_id],
        sourceType: "performance_review",
        sourceId: review.id,
        metadata: {
          reviewType: review.type,
          cycleId: review.cycle_id,
          overallScore: row.rows[0]?.overall_score ?? null,
        },
      });
    }

    res.json(row.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * All post-submission logic isolated here so the HTTP response is never blocked.
 */
async function handleReviewSubmissionSideEffects({ review, newStatus, workspaceId }) {
  if (newStatus !== "submitted") return;

  // ── 1. Self-review submitted → ensure manager review row exists + notify ───
  if (review.type === "self") {
    // Look up manager for the reviewee
    const { rows: memberRows } = await db.query(
      `SELECT wu.manager_id, u.username AS reviewee_name
       FROM workspace_users wu
       JOIN users u ON u.id = wu.user_id
       WHERE wu.workspace_id = $1 AND wu.user_id = $2`,
      [workspaceId, review.reviewee_id]
    );
    const managerId    = memberRows[0]?.manager_id;
    const revieweeName = memberRows[0]?.reviewee_name || "A team member";

    if (managerId) {
      // Guarantee manager review row exists (idempotent)
      await db.query(
        `INSERT INTO performance_reviews (cycle_id, reviewee_id, reviewer_id, type)
         VALUES ($1, $2, $3, 'manager')
         ON CONFLICT (cycle_id, reviewee_id, reviewer_id, type) DO NOTHING`,
        [review.cycle_id, review.reviewee_id, managerId]
      );

      // Fetch cycle name for the notification
      const { rows: cycleRows } = await db.query(
        `SELECT name FROM review_cycles WHERE id = $1`,
        [review.cycle_id]
      );
      const cycleName = cycleRows[0]?.name || "Performance Review";

      // Notify the manager — review is now unlocked
      notifyUser({
        user_id:     managerId,
        type:        "manager_review_unlocked",
        message:     `✅ ${revieweeName} has submitted their self-review for "${cycleName}". Your manager review is now unlocked and ready to complete.`,
        workspaceId,
      }).catch(() => {});
    }
  }

  // ── 2. Any review submitted → auto-complete cycle if all reviews are done ──
  const { rows: pendingRows } = await db.query(
    `SELECT COUNT(*) AS cnt
     FROM performance_reviews
     WHERE cycle_id = $1 AND status NOT IN ('submitted', 'missed')`,
    [review.cycle_id]
  );
  if (Number(pendingRows[0].cnt) > 0) return; // still reviews outstanding

  // Guard: don't auto-complete an empty cycle (0 rows at all)
  const { rows: totalRows } = await db.query(
    `SELECT COUNT(*) AS cnt FROM performance_reviews WHERE cycle_id = $1`,
    [review.cycle_id]
  );
  if (Number(totalRows[0].cnt) === 0) return;

  // Try to complete the cycle (only if still 'active', so manual completes are safe)
  const { rows: completed } = await db.query(
    `UPDATE review_cycles SET status = 'completed'
     WHERE id = $1 AND status = 'active'
     RETURNING id, name, workspace_id`,
    [review.cycle_id]
  );
  if (!completed[0]) return; // already completed or not active

  const c = completed[0];
  console.log(`[reviews] Auto-completed cycle "${c.name}" — all reviews done`);

  // Build completion summary
  const { rows: stats } = await db.query(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE status = 'submitted') AS submitted,
            COUNT(*) FILTER (WHERE status = 'missed')    AS missed_count,
            ROUND(AVG(overall_score) FILTER (WHERE status = 'submitted'), 1) AS avg_score
     FROM performance_reviews WHERE cycle_id = $1`,
    [c.id]
  );
  const s   = stats[0];
  const msg = `🎉 "${c.name}" auto-completed — all reviews done. ${s.submitted}/${s.total} submitted${
    Number(s.missed_count) > 0 ? `, ${s.missed_count} missed` : ""
  }${s.avg_score ? `, avg score ${s.avg_score}/5` : ""}.`;

  // Notify all admins and owners
  const { rows: admins } = await db.query(
    `SELECT wu.user_id FROM workspace_users wu
     WHERE wu.workspace_id = $1 AND wu.role IN ('admin','owner')`,
    [c.workspace_id]
  );
  for (const a of admins) {
    notifyUser({
      user_id:     a.user_id,
      type:        "review_cycle_complete",
      message:     msg,
      workspaceId: c.workspace_id,
    }).catch(() => {});
  }
}

// ─── SUMMARY ─────────────────────────────────────────────────────────────────

router.get("/cycles/:cycleId/summary", async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT pr.reviewee_id, u.username, u.email,
              COUNT(*) FILTER (WHERE pr.status = 'submitted') AS submitted,
              COUNT(*) AS total,
              ROUND(AVG(pr.overall_score) FILTER (WHERE pr.status = 'submitted'), 2) AS avg_score
       FROM performance_reviews pr
       JOIN users u ON u.id = pr.reviewee_id
       WHERE pr.cycle_id = $1
         AND pr.type IN ('self','manager')
       GROUP BY pr.reviewee_id, u.username, u.email
       ORDER BY u.username`,
      [req.params.cycleId]
    );
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── TEAM REPORTING LINES ─────────────────────────────────────────────────────

/**
 * Bulk-assign a manager to multiple (or all) workspace members.
 * MUST be declared before /team/:userId/manager to prevent route capture.
 */
router.patch("/team/bulk-manager", async (req, res) => {
  try {
    if (!["admin", "owner"].includes(req.user.role)) {
      return res.status(403).json({ error: "Admin required" });
    }

    const { user_ids, manager_id } = req.body;

    // Validate manager exists in workspace (if not clearing)
    if (manager_id) {
      const check = await db.query(
        `SELECT user_id FROM workspace_users WHERE workspace_id = $1 AND user_id = $2`,
        [req.workspaceId, manager_id]
      );
      if (check.rows.length === 0) {
        return res.status(400).json({ error: "manager_id is not a member of this workspace" });
      }
    }

    let updatedCount;

    if (Array.isArray(user_ids) && user_ids.length > 0) {
      // Update specific members — never self-assign
      const filteredIds = user_ids.filter(id => id !== manager_id);
      const result = await db.query(
        `UPDATE workspace_users SET manager_id = $1
         WHERE workspace_id = $2 AND user_id = ANY($3::uuid[])`,
        [manager_id || null, req.workspaceId, filteredIds]
      );
      updatedCount = result.rowCount;
    } else {
      // Update ALL members (excluding the manager themselves)
      const result = await db.query(
        `UPDATE workspace_users SET manager_id = $1
         WHERE workspace_id = $2
           AND ($1::uuid IS NULL OR user_id != $1)`,
        [manager_id || null, req.workspaceId]
      );
      updatedCount = result.rowCount;
    }

    await logAudit({
      workspaceId: req.workspaceId, userId: req.user.id,
      action: "team.bulk_manager_assign", entityType: "workspace_users", entityId: req.workspaceId,
    });

    // Create any missing manager review rows for active cycles
    if (manager_id) {
      const { rows: activeCycles } = await db.query(
        `SELECT id FROM review_cycles WHERE workspace_id = $1 AND status = 'active'`,
        [req.workspaceId]
      );
      for (const cycle of activeCycles) {
        await autoAssignReviews(cycle.id, req.workspaceId);
      }
    }

    res.json({ success: true, updated: updatedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Get all workspace members with their manager info */
router.get("/team", async (req, res) => {
  try {
    if (!["admin", "owner"].includes(req.user.role)) return res.status(403).json({ error: "Admin required" });
    const rows = await db.query(
      `SELECT wu.user_id, wu.manager_id, wu.role,
              u.username, u.email,
              m.username AS manager_name
       FROM workspace_users wu
       JOIN users u ON u.id = wu.user_id
       LEFT JOIN users m ON m.id = wu.manager_id
       WHERE wu.workspace_id = $1
       ORDER BY u.username`,
      [req.workspaceId]
    );
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Set manager for a single team member */
router.patch("/team/:userId/manager", async (req, res) => {
  try {
    if (!["admin", "owner"].includes(req.user.role)) return res.status(403).json({ error: "Admin required" });
    const { manager_id } = req.body;

    // Prevent self-assignment
    if (manager_id && manager_id === req.params.userId) {
      return res.status(400).json({ error: "A member cannot be their own manager" });
    }

    await db.query(
      `UPDATE workspace_users SET manager_id = $1
       WHERE workspace_id = $2 AND user_id = $3`,
      [manager_id || null, req.workspaceId, req.params.userId]
    );

    // Create any missing manager review rows for active cycles
    if (manager_id) {
      const { rows: activeCycles } = await db.query(
        `SELECT id FROM review_cycles WHERE workspace_id = $1 AND status = 'active'`,
        [req.workspaceId]
      );
      for (const cycle of activeCycles) {
        await autoAssignReviews(cycle.id, req.workspaceId);
      }
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
