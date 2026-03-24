// routes/leave.routes.js
import express from "express";
import db from "../db.js";
import { logAudit } from "../services/audit.service.js";
import { sendLeaveRequestEmail, sendLeaveStatusEmail } from "../services/email.service.js";
import { notifyUser } from "../services/notification.service.js";

const router = express.Router();

// ─── LEAVE TYPES ──────────────────────────────────────────────────────────────

router.get("/types", async (req, res) => {
  try {
    const rows = await db.query(
      "SELECT * FROM leave_types WHERE workspace_id = $1 ORDER BY name ASC",
      [req.workspaceId]
    );
    if (rows.rows.length === 0) {
      // Seed default types on first access
      await db.query(
        `INSERT INTO leave_types (workspace_id, name, color, max_days, carry_over)
         VALUES ($1,'Annual','#6366f1',21,true),
                ($1,'Sick','#ef4444',14,false),
                ($1,'Unpaid','#9ca3af',NULL,false),
                ($1,'Personal','#f59e0b',5,false)
         ON CONFLICT DO NOTHING`,
        [req.workspaceId]
      );
      const seeded = await db.query(
        "SELECT * FROM leave_types WHERE workspace_id = $1 ORDER BY name ASC",
        [req.workspaceId]
      );
      return res.json(seeded.rows);
    }
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/types", async (req, res) => {
  try {
    if (!["admin", "owner"].includes(req.user.role)) return res.status(403).json({ error: "Admin required" });
    const { name, color = "#6366f1", max_days, carry_over = false, requires_doc = false } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });

    const row = await db.query(
      "INSERT INTO leave_types (workspace_id, name, color, max_days, carry_over, requires_doc) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
      [req.workspaceId, name, color, max_days || null, carry_over, requires_doc]
    );
    res.status(201).json(row.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/types/:id", async (req, res) => {
  try {
    if (!["admin", "owner"].includes(req.user.role)) return res.status(403).json({ error: "Admin required" });
    const { name, color, max_days, carry_over, requires_doc } = req.body;
    const row = await db.query(
      `UPDATE leave_types SET
         name         = COALESCE($1, name),
         color        = COALESCE($2, color),
         max_days     = $3,
         carry_over   = COALESCE($4, carry_over),
         requires_doc = COALESCE($5, requires_doc)
       WHERE id = $6 AND workspace_id = $7 RETURNING *`,
      [name, color, max_days ?? null, carry_over, requires_doc, req.params.id, req.workspaceId]
    );
    res.json(row.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/types/:id", async (req, res) => {
  try {
    if (!["admin", "owner"].includes(req.user.role)) return res.status(403).json({ error: "Admin required" });
    await db.query("DELETE FROM leave_types WHERE id = $1 AND workspace_id = $2", [req.params.id, req.workspaceId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── LEAVE REQUESTS ────────────────────────────────────────────────────────────

router.get("/requests", async (req, res) => {
  try {
    const { status, userId, startDate, endDate } = req.query;
    const isAdmin = ["admin", "owner"].includes(req.user.role);
    const targetUser = isAdmin ? (userId || null) : req.user.id;

    const conditions = ["lr.workspace_id = $1"];
    const params = [req.workspaceId];
    let i = 2;

    if (targetUser) { conditions.push(`lr.user_id = $${i++}`); params.push(targetUser); }
    if (status) { conditions.push(`lr.status = $${i++}`); params.push(status); }
    if (startDate) { conditions.push(`lr.end_date >= $${i++}`); params.push(startDate); }
    if (endDate) { conditions.push(`lr.start_date <= $${i++}`); params.push(endDate); }

    const rows = await db.query(
      `SELECT lr.*, lt.name AS leave_type_name, lt.color AS leave_type_color,
              u.username, u.email,
              r.username AS reviewer_name
       FROM leave_requests lr
       JOIN leave_types lt ON lt.id = lr.leave_type_id
       JOIN users u ON u.id = lr.user_id
       LEFT JOIN users r ON r.id = lr.reviewed_by
       WHERE ${conditions.join(" AND ")}
       ORDER BY lr.created_at DESC`,
      params
    );
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/requests", async (req, res) => {
  try {
    const { leave_type_id, start_date, end_date, reason, document_url } = req.body;
    if (!leave_type_id || !start_date || !end_date) {
      return res.status(400).json({ error: "leave_type_id, start_date, and end_date are required" });
    }

    // Calculate working days using workspace schedule + holidays
    const [sy, sm, sd] = String(start_date).split("T")[0].split("-").map(Number);
    const [ey, em, ed] = String(end_date).split("T")[0].split("-").map(Number);
    const start = new Date(sy, sm - 1, sd);
    const end   = new Date(ey, em - 1, ed);
    if (end < start) return res.status(400).json({ error: "end_date must be after start_date" });

    // Fetch workspace work schedule (default Mon–Fri if not configured)
    const schedResult = await db.query(
      `SELECT work_days FROM workspace_work_schedule WHERE workspace_id = $1`,
      [req.workspaceId]
    );
    const workDayNums = (schedResult.rows[0]?.work_days || [1, 2, 3, 4, 5]).map(Number);

    // Fetch holidays in the leave date range
    const startStr = start.toISOString().slice(0, 10);
    const endStr   = end.toISOString().slice(0, 10);
    const holResult = await db.query(
      `SELECT date::text AS date FROM workspace_holidays
       WHERE workspace_id = $1 AND date BETWEEN $2 AND $3`,
      [req.workspaceId, startStr, endStr]
    ).catch(() => ({ rows: [] })); // graceful if table doesn't exist yet
    const holidayDates = new Set(holResult.rows.map(r => r.date.slice(0, 10)));

    let days = 0;
    const cur = new Date(start);
    while (cur <= end) {
      const dow     = cur.getDay();
      const dateStr = cur.toISOString().slice(0, 10);
      if (workDayNums.includes(dow) && !holidayDates.has(dateStr)) days++;
      cur.setDate(cur.getDate() + 1);
    }

    const row = await db.query(
      `INSERT INTO leave_requests
         (workspace_id, user_id, leave_type_id, start_date, end_date, days, reason, document_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.workspaceId, req.user.id, leave_type_id, start_date, end_date, days, reason || null, document_url || null]
    );

    await logAudit({ workspaceId: req.workspaceId, userId: req.user.id, action: "leave.request.create", entityType: "leave_request", entityId: row.rows[0].id });

    // Notify admins (email + in-app)
    const adminRows = await db.query(
      `SELECT u.id, u.email, u.username FROM users u
       JOIN workspace_users wu ON wu.user_id = u.id
       WHERE wu.workspace_id = $1 AND wu.role = 'admin'`,
      [req.workspaceId]
    );
    const typeRow = await db.query("SELECT name FROM leave_types WHERE id = $1", [leave_type_id]);
    const leaveTypeName = typeRow.rows[0]?.name || "Leave";
    for (const admin of adminRows.rows) {
      sendLeaveRequestEmail({
        to: admin.email, username: admin.username,
        requester: req.user.username,
        leaveType: leaveTypeName,
        startDate: start_date, endDate: end_date, days,
        reviewUrl: `${process.env.FRONTEND_URL || "http://localhost:5173"}/leave`,
      });
      notifyUser({
        user_id: admin.id,
        type: "leave_request",
        message: `${req.user.username} requested ${days} day(s) of ${leaveTypeName} (${start_date} → ${end_date})`,
        workspaceId: req.workspaceId,
      }).catch(() => {});
    }

    res.status(201).json(row.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Approve / Reject a leave request */
router.patch("/requests/:id/review", async (req, res) => {
  try {
    if (!["admin", "owner"].includes(req.user.role)) return res.status(403).json({ error: "Admin required" });

    const { status, review_note } = req.body;
    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({ error: "status must be 'approved' or 'rejected'" });
    }

    const row = await db.query(
      `UPDATE leave_requests SET
         status      = $1,
         reviewed_by = $2,
         review_note = $3,
         reviewed_at = NOW(),
         updated_at  = NOW()
       WHERE id = $4 AND workspace_id = $5
       RETURNING *`,
      [status, req.user.id, review_note || null, req.params.id, req.workspaceId]
    );
    if (!row.rows[0]) return res.status(404).json({ error: "Request not found" });

    const req_ = row.rows[0];

    // If approved, deduct from balance
    if (status === "approved") {
      const year = new Date(req_.start_date).getFullYear();
      await db.query(
        `INSERT INTO leave_balances (workspace_id, user_id, leave_type_id, year, allocated, used)
         VALUES ($1,$2,$3,$4,0,$5)
         ON CONFLICT (workspace_id, user_id, leave_type_id, year)
         DO UPDATE SET used = leave_balances.used + $5`,
        [req.workspaceId, req_.user_id, req_.leave_type_id, year, req_.days]
      );
    }

    // Notify requester (email + in-app)
    const userRow = await db.query("SELECT id, email, username FROM users WHERE id = $1", [req_.user_id]);
    const typeRow = await db.query("SELECT name FROM leave_types WHERE id = $1", [req_.leave_type_id]);
    if (userRow.rows[0]) {
      const leaveTypeName = typeRow.rows[0]?.name || "Leave";
      const statusEmoji = status === "approved" ? "✅" : "❌";
      sendLeaveStatusEmail({
        to: userRow.rows[0].email, username: userRow.rows[0].username,
        status, leaveType: leaveTypeName,
        startDate: req_.start_date, endDate: req_.end_date,
        reviewNote: review_note,
      });
      notifyUser({
        user_id: userRow.rows[0].id,
        type: "leave_status",
        message: `${statusEmoji} Your ${leaveTypeName} request (${req_.start_date} → ${req_.end_date}) was ${status}${review_note ? `: "${review_note}"` : ""}`,
        workspaceId: req.workspaceId,
      }).catch(() => {});
    }

    await logAudit({ workspaceId: req.workspaceId, userId: req.user.id, action: `leave.request.${status}`, entityType: "leave_request", entityId: req.params.id });
    res.json(row.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Cancel own request */
router.patch("/requests/:id/cancel", async (req, res) => {
  try {
    const row = await db.query(
      `UPDATE leave_requests SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND status = 'pending'
       RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (!row.rows[0]) return res.status(404).json({ error: "Request not found or already processed" });
    res.json(row.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── LEAVE BALANCES ───────────────────────────────────────────────────────────

router.get("/balances", async (req, res) => {
  try {
    const year = req.query.year || new Date().getFullYear();
    const userId = ["admin", "owner"].includes(req.user.role)
      ? (req.query.userId || null)
      : req.user.id;

    const cond = userId ? "AND lb.user_id = $3" : "";
    const params = [req.workspaceId, year, ...(userId ? [userId] : [])];

    const rows = await db.query(
      `SELECT lb.*, lt.name, lt.color, lt.max_days,
              u.username, u.email
       FROM leave_balances lb
       JOIN leave_types lt ON lt.id = lb.leave_type_id
       JOIN users u ON u.id = lb.user_id
       WHERE lb.workspace_id = $1 AND lb.year = $2 ${cond}
       ORDER BY u.username, lt.name`,
      params
    );
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/balances", async (req, res) => {
  try {
    if (!["admin", "owner"].includes(req.user.role)) return res.status(403).json({ error: "Admin required" });
    const { user_id, leave_type_id, year, allocated } = req.body;

    const row = await db.query(
      `INSERT INTO leave_balances (workspace_id, user_id, leave_type_id, year, allocated, used)
       VALUES ($1,$2,$3,$4,$5,0)
       ON CONFLICT (workspace_id, user_id, leave_type_id, year)
       DO UPDATE SET allocated = $5
       RETURNING *`,
      [req.workspaceId, user_id, leave_type_id, year || new Date().getFullYear(), allocated]
    );
    res.json(row.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
