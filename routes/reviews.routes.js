// routes/reviews.routes.js
import express from "express";
import db from "../db.js";
import { logAudit } from "../services/audit.service.js";
import { sendPerformanceReviewEmail } from "../services/email.service.js";
import { autoAssignReviews, getQuarterInfo } from "../cron/reviews.cron.js";

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
    const { name, type = "quarterly", start_date, end_date, peer_review_count = 2 } = req.body;
    if (!name || !start_date || !end_date) return res.status(400).json({ error: "name, start_date, end_date required" });

    const row = await db.query(
      `INSERT INTO review_cycles (workspace_id, name, type, start_date, end_date, peer_review_count)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.workspaceId, name, type, start_date, end_date, peer_review_count]
    );
    res.status(201).json(row.rows[0]);
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

    // Auto-assign reviews when a cycle is manually activated
    if (status === "active") {
      autoAssignReviews(cycle.id, req.workspaceId, cycle.peer_review_count || 2).catch(err =>
        console.error("[reviews] Auto-assign error:", err.message)
      );
    }

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

    // Check if already exists
    const existing = await db.query(
      `SELECT id FROM review_cycles WHERE workspace_id = $1 AND name = $2`,
      [req.workspaceId, q.name]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: `Cycle "${q.name}" already exists` });
    }

    const { rows } = await db.query(
      `INSERT INTO review_cycles
         (workspace_id, name, type, start_date, end_date, status, auto_generated, peer_review_count)
       VALUES ($1,$2,$3,$4,$5,'active',true,2)
       RETURNING *`,
      [req.workspaceId, q.name, q.type, q.startStr, q.endStr]
    );

    const cycle = rows[0];
    const reviewerCount = await autoAssignReviews(cycle.id, req.workspaceId, 2);

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
      WHERE pr.cycle_id = $1`;
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
              rc.name AS cycle_name, rc.end_date AS cycle_end_date, rc.status AS cycle_status
       FROM performance_reviews pr
       JOIN users rv ON rv.id = pr.reviewee_id
       JOIN review_cycles rc ON rc.id = pr.cycle_id
       WHERE pr.reviewer_id = $1
         AND pr.status != 'submitted'
         AND rc.workspace_id = $2
         AND rc.status = 'active'
       ORDER BY rc.end_date ASC, rv.username`,
      [req.user.id, req.workspaceId]
    );
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** All submitted reviews ABOUT ME (across all cycles) */
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
         AND pr.status = 'submitted'
         AND rc.workspace_id = $2
       ORDER BY rc.end_date DESC`,
      [req.user.id, req.workspaceId]
    );
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Latest intelligence context for a reviewee (to show in the review form) */
router.get("/user-context/:userId", async (req, res) => {
  // Users can only see their own context; admin/manager can see anyone's
  if (req.user.role === "user" && req.user.id !== req.params.userId) {
    return res.status(403).json({ error: "Not allowed" });
  }
  try {
    const rows = await db.query(
      `SELECT month, score, breakdown
       FROM workspace_monthly_scores
       WHERE workspace_id = $1 AND user_id = $2
       ORDER BY month DESC LIMIT 1`,
      [req.workspaceId, req.params.userId]
    );
    res.json(rows.rows[0] || null);
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

/** Submit / update a review */
router.put("/reviews/:reviewId", async (req, res) => {
  try {
    const { overall_score, strengths, improvements, goals_next, answers, status } = req.body;

    const existing = await db.query(
      "SELECT * FROM performance_reviews WHERE id = $1 AND reviewer_id = $2",
      [req.params.reviewId, req.user.id]
    );
    if (!existing.rows[0] && !["admin", "owner"].includes(req.user.role)) {
      return res.status(403).json({ error: "Access denied" });
    }

    const newStatus = status === "submitted"
      ? "submitted"
      : (existing.rows[0]?.status === "submitted" ? "submitted" : "in_progress");

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
      [overall_score, strengths, improvements, goals_next, answers ? JSON.stringify(answers) : null, newStatus, req.params.reviewId]
    );

    await logAudit({ workspaceId: req.workspaceId, userId: req.user.id, action: "review.submit", entityType: "review", entityId: req.params.reviewId });
    res.json(row.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
       GROUP BY pr.reviewee_id, u.username, u.email
       ORDER BY u.username`,
      [req.params.cycleId]
    );
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── TEAM REPORTING LINES (manager assignment) ───────────────────────────────

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

/** Set manager for a team member */
router.patch("/team/:userId/manager", async (req, res) => {
  try {
    if (!["admin", "owner"].includes(req.user.role)) return res.status(403).json({ error: "Admin required" });
    const { manager_id } = req.body; // null = remove manager

    await db.query(
      `UPDATE workspace_users SET manager_id = $1
       WHERE workspace_id = $2 AND user_id = $3`,
      [manager_id || null, req.workspaceId, req.params.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
