// routes/reviews.routes.js
import express from "express";
import db from "../db.js";
import { logAudit } from "../services/audit.service.js";
import { sendPerformanceReviewEmail } from "../services/email.service.js";

const router = express.Router();

// ─── REVIEW CYCLES ────────────────────────────────────────────────────────────

router.get("/cycles", async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT rc.*,
              (SELECT COUNT(*) FROM performance_reviews WHERE cycle_id = rc.id) AS review_count
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
      "INSERT INTO review_cycles (workspace_id, name, type, start_date, end_date) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [req.workspaceId, name, type, start_date, end_date]
    );
    res.status(201).json(row.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/cycles/:id/status", async (req, res) => {
  try {
    if (!["admin", "owner"].includes(req.user.role)) return res.status(403).json({ error: "Admin required" });
    const { status } = req.body;
    if (!["draft", "active", "completed"].includes(status)) return res.status(400).json({ error: "Invalid status" });

    const row = await db.query(
      "UPDATE review_cycles SET status = $1 WHERE id = $2 AND workspace_id = $3 RETURNING *",
      [status, req.params.id, req.workspaceId]
    );
    res.json(row.rows[0]);
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

/** Create a review request */
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

    // Send notification email
    const [cycleRow, revieweeRow, reviewerRow] = await Promise.all([
      db.query("SELECT name, end_date FROM review_cycles WHERE id = $1", [req.params.cycleId]),
      db.query("SELECT email, username FROM users WHERE id = $1", [reviewee_id]),
      db.query("SELECT email, username FROM users WHERE id = $1", [reviewer_id]),
    ]);

    const cycle = cycleRow.rows[0];
    const reviewee = revieweeRow.rows[0];
    const reviewer = reviewerRow.rows[0];

    if (reviewer?.email) {
      sendPerformanceReviewEmail({
        to: reviewer.email,
        username: reviewer.username,
        reviewerName: type === "self" ? null : reviewee?.username,
        cycleName: cycle?.name,
        dueDate: cycle?.end_date,
        reviewUrl: `${process.env.FRONTEND_URL || "http://localhost:5173"}/reviews`,
      });
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

    const newStatus = status === "submitted" ? "submitted" : (existing.rows[0]?.status === "submitted" ? "submitted" : "in_progress");

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

export default router;
