import pool from "../../db.js";

function getMonthRange(month) {
  const start = new Date(`${month}-01T00:00:00.000Z`);
  const end = new Date(start);
  end.setMonth(end.getMonth() + 1);
  end.setMilliseconds(-1);
  return { start, end };
}

/**
 * Build rich evidence + normalized metrics for a user in a month.
 *
 * Returns:
 *   metrics  — all ratios (0–1) consumed by scoreCalculator
 *   evidence — human-readable strings for audit trail
 *
 * READ-ONLY. Deterministic. Safe to re-run.
 */
export async function buildUserEvidence({ workspaceId, userId, month }) {
  const { start: monthStart, end: monthEnd } = getMonthRange(month);
  const monthStartStr = monthStart.toISOString().slice(0, 10);
  const monthEndStr   = monthEnd.toISOString().slice(0, 10);

  /* ═══════════════════════════════════════════════════════════
     ATTENDANCE BLOCK
     Source: attendance_daily (pre-aggregated by attendanceCalculation)
     Fallback: attendance_sessions (presence only)
  ═══════════════════════════════════════════════════════════ */

  // ── Work Calendar: expected working days from schedule + holidays + leave ────
  // Workspace work schedule (which DOWs are working days, default Mon–Fri)
  const { rows: scheduleRows } = await pool.query(
    `SELECT work_days FROM workspace_work_schedule WHERE workspace_id = $1`,
    [workspaceId]
  );
  const workDayNums = (scheduleRows[0]?.work_days || [1, 2, 3, 4, 5]).map(Number);

  // Company holidays in the month
  const { rows: holidayRows } = await pool.query(
    `SELECT date::text AS date FROM workspace_holidays
     WHERE workspace_id = $1 AND date BETWEEN $2 AND $3`,
    [workspaceId, monthStartStr, monthEndStr]
  );
  const holidayDates = new Set(holidayRows.map(r => r.date.slice(0, 10)));

  // Approved leave days for this user in the month
  const { rows: leaveRows } = await pool.query(
    `SELECT d::date::text AS day
     FROM leave_requests lr
     CROSS JOIN LATERAL generate_series(lr.start_date, lr.end_date, '1 day'::interval) d
     WHERE lr.workspace_id = $1
       AND lr.user_id      = $2
       AND lr.status       = 'approved'
       AND lr.end_date     >= $3
       AND lr.start_date   <= $4`,
    [workspaceId, userId, monthStartStr, monthEndStr]
  );
  const leaveDates = new Set(leaveRows.map(r => r.day.slice(0, 10)));

  // Walk the month to count expected working days (excl. holidays + approved leave)
  let expectedWorkingDays = 0;
  const calCursor = new Date(monthStart);
  const calLimit  = new Date(monthEnd);
  while (calCursor <= calLimit) {
    const dow     = calCursor.getDay(); // 0=Sun … 6=Sat
    const dateStr = calCursor.toISOString().slice(0, 10);
    if (workDayNums.includes(dow) && !holidayDates.has(dateStr) && !leaveDates.has(dateStr)) {
      expectedWorkingDays++;
    }
    calCursor.setDate(calCursor.getDate() + 1);
  }

  // ── Rich daily data (actual sign-ins) ────────────────────────────────────────
  const { rows: dailyRows } = await pool.query(
    `SELECT
       COUNT(*)                                              AS present_days,
       AVG(signed_in_minutes)                               AS avg_signed_in_min,
       AVG(screen_on_minutes)                               AS avg_screen_on_min,
       AVG(available_minutes)                               AS avg_available_min,
       ARRAY_AGG(EXTRACT(DOW FROM date)::int ORDER BY date) AS days_of_week
     FROM attendance_daily
     WHERE workspace_id = $1
       AND user_id      = $2
       AND date BETWEEN $3 AND $4`,
    [workspaceId, userId, monthStartStr, monthEndStr]
  );

  const presentDays  = Number(dailyRows[0]?.present_days    || 0);
  const avgSignedIn  = Number(dailyRows[0]?.avg_signed_in_min  || 0);
  const avgScreenOn  = Number(dailyRows[0]?.avg_screen_on_min  || 0);
  const avgAvailable = Number(dailyRows[0]?.avg_available_min  || 0);
  const dowArray     = (dailyRows[0]?.days_of_week || []).map(Number);

  // ── Presence ─────────────────────────────────────────────────────────────────
  // present / expected — absence on working days (not on holiday/leave) is penalised
  const attendancePresenceRatio = expectedWorkingDays > 0
    ? Math.min(presentDays / expectedWorkingDays, 1)
    : 0;

  // ── Hour Quality (480 min = 8h expected) ──────────────────────────────────────
  const EXPECTED_MINUTES = 480;
  const attendanceHourQualityRatio = presentDays > 0
    ? Math.min(avgSignedIn / EXPECTED_MINUTES, 1)
    : 0;

  // ── Active Time Ratio (screen-on / available) ──────────────────────────────────
  const attendanceActiveTimeRatio = avgAvailable > 0
    ? Math.min(avgScreenOn / avgAvailable, 1)
    : (presentDays > 0 ? 0.5 : 0);

  // ── Consistency (DOW absence pattern vs expected calendar) ────────────────────
  // Count how many of each working DOW the user was present vs expected
  let consistencyRatio = 1;
  if (expectedWorkingDays >= 4) {
    // Expected occurrences of each DOW in the month (excluding holidays/leave)
    const expectedDow = {};
    const presentDow  = {};
    for (const d of workDayNums) { expectedDow[d] = 0; presentDow[d] = 0; }

    const cur2 = new Date(monthStart);
    while (cur2 <= new Date(monthEnd)) {
      const d2      = cur2.getDay();
      const dStr    = cur2.toISOString().slice(0, 10);
      if (workDayNums.includes(d2) && !holidayDates.has(dStr) && !leaveDates.has(dStr)) {
        expectedDow[d2] = (expectedDow[d2] || 0) + 1;
      }
      cur2.setDate(cur2.getDate() + 1);
    }
    for (const d of dowArray) {
      if (workDayNums.includes(d)) presentDow[d] = (presentDow[d] || 0) + 1;
    }

    const dowRatios = [];
    for (const d of workDayNums) {
      const expected = expectedDow[d] || 0;
      if (expected === 0) continue;
      const absent = Math.max(0, expected - (presentDow[d] || 0));
      dowRatios.push(absent / expected);
    }
    if (dowRatios.length > 0) {
      const maxAbsence = Math.max(...dowRatios);
      const avgAbsence = dowRatios.reduce((a, b) => a + b, 0) / dowRatios.length;
      consistencyRatio = Math.max(0, 1 - (maxAbsence > 0.3 ? maxAbsence * 0.8 : avgAbsence * 0.5));
    }
  }

  /* ═══════════════════════════════════════════════════════════
     PRODUCTIVITY BLOCK
  ═══════════════════════════════════════════════════════════ */

  // ── Task Completion ───────────────────────────────────────
  const { rows: taskRows } = await pool.query(
    `SELECT
       COUNT(*)                                      AS total_tasks,
       COUNT(*) FILTER (WHERE status = 'completed')  AS completed_tasks,
       COALESCE(SUM(story_points) FILTER (WHERE status = 'completed'), 0) AS completed_points,
       COALESCE(SUM(estimation_hours) FILTER (WHERE status = 'completed' AND estimation_hours IS NOT NULL), 0) AS estimated_hours_completed
     FROM tasks
     WHERE workspace_id = $1
       AND assigned_to  = $2
       AND created_at BETWEEN $3::timestamptz AND $4::timestamptz`,
    [workspaceId, userId, monthStart, monthEnd]
  );

  const totalTasks         = Number(taskRows[0]?.total_tasks         || 0);
  const completedTasks     = Number(taskRows[0]?.completed_tasks     || 0);
  const completedPoints    = Number(taskRows[0]?.completed_points    || 0);
  const estimatedHoursCompleted = Number(taskRows[0]?.estimated_hours_completed || 0);

  const taskCompletionRatio = totalTasks > 0 ? completedTasks / totalTasks : 0;

  // ── Timeliness (unified) ──────────────────────────────────
  // Denominator = all tasks with a due date (completed + overdue + pending).
  // This prevents inflated timeliness when a user completes 1 task on time
  // but leaves 5 others overdue. Uses completed_at (not updated_at which
  // changes on every edit regardless of completion status).
  const { rows: timelinessRows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE due_date IS NOT NULL)                         AS tasks_with_due,
       COUNT(*) FILTER (
         WHERE status     = 'completed'
           AND due_date   IS NOT NULL
           AND completed_at IS NOT NULL
           AND completed_at <= due_date
       )                                                                    AS on_time,
       COUNT(*) FILTER (
         WHERE due_date IS NOT NULL
           AND status   != 'completed'
           AND due_date <  NOW()
       )                                                                    AS active_overdue
     FROM tasks
     WHERE workspace_id = $1
       AND assigned_to  = $2
       AND created_at BETWEEN $3::timestamptz AND $4::timestamptz`,
    [workspaceId, userId, monthStart, monthEnd]
  );

  const tasksWithDue    = Number(timelinessRows[0]?.tasks_with_due || 0);
  const onTime          = Number(timelinessRows[0]?.on_time        || 0);
  const activeOverdueTL = Number(timelinessRows[0]?.active_overdue || 0);
  // Neutral (0.5) when no due dates set — don't penalise for unmeasured work
  const timelinessRatio = tasksWithDue > 0 ? onTime / tasksWithDue : 0.5;

  // ── Story Point Velocity ──────────────────────────────────
  // Workspace avg points/month for normalisation (or target = 40 pts)
  const { rows: wsPointsRows } = await pool.query(
    `SELECT AVG(pts) AS avg_pts FROM (
       SELECT assigned_to,
              SUM(story_points) AS pts
       FROM tasks
       WHERE workspace_id = $1
         AND status       = 'completed'
         AND created_at BETWEEN $2::timestamptz AND $3::timestamptz
         AND story_points IS NOT NULL
       GROUP BY assigned_to
     ) sub`,
    [workspaceId, monthStart, monthEnd]
  );
  const wsAvgPoints = Number(wsPointsRows[0]?.avg_pts || 0);
  const pointsTarget = wsAvgPoints > 0 ? wsAvgPoints : 40; // 40 pts default target
  const storyPointVelocityRatio = completedPoints > 0
    ? Math.min(completedPoints / pointsTarget, 1)
    : taskCompletionRatio > 0 ? taskCompletionRatio : 0.5; // neutral when workspace doesn't use story points

  // ── Estimation Accuracy ───────────────────────────────────
  // Compare estimated_hours on completed tasks vs actual logged hours
  let estimationAccuracyRatio = 0.5; // neutral default if no data
  if (estimatedHoursCompleted > 0) {
    const { rows: timeLogRows } = await pool.query(
      `SELECT COALESCE(SUM(tl.hours), 0) AS actual_hours
       FROM time_logs tl
       JOIN tasks t ON t.id = tl.task_id
       WHERE tl.workspace_id = $1
         AND tl.user_id      = $2
         AND t.status        = 'completed'
         AND tl.log_date BETWEEN $3 AND $4`,
      [workspaceId, userId, monthStartStr, monthEndStr]
    );
    const actualHours = Number(timeLogRows[0]?.actual_hours || 0);
    if (actualHours > 0) {
      const deviation = Math.abs(actualHours - estimatedHoursCompleted)
        / Math.max(actualHours, estimatedHoursCompleted);
      estimationAccuracyRatio = Math.max(0, 1 - deviation);
    }
  }

  // ── Collaboration ─────────────────────────────────────────
  const { rows: commentRows } = await pool.query(
    `SELECT COUNT(*) AS comments
     FROM comments
     WHERE workspace_id = $1
       AND added_by     = $2
       AND created_at BETWEEN $3::timestamptz AND $4::timestamptz`,
    [workspaceId, userId, monthStart, monthEnd]
  );
  const comments = Number(commentRows[0]?.comments || 0);
  // Watchers added (proxy for collaboration reach)
  const { rows: watcherRows } = await pool.query(
    `SELECT COUNT(*) AS watched
     FROM task_watchers
     WHERE workspace_id = $1
       AND user_id      = $2
       AND created_at BETWEEN $3::timestamptz AND $4::timestamptz`,
    [workspaceId, userId, monthStart, monthEnd]
  );
  const watched = Number(watcherRows[0]?.watched || 0);
  // Score: 5 comments = full; each watch = 0.5 comment equivalent.
  // Neutral (0.5) when neither feature is used — avoid penalising workspaces
  // that don't have a commenting culture.
  const collaborationSignals = comments + watched * 0.5;
  const collaborationRatio = collaborationSignals === 0
    ? 0.5
    : Math.min(collaborationSignals / 5, 1);

  // ── Blocker Resolution ────────────────────────────────────
  // Tasks assigned to user that were blocked and got completed this month
  const { rows: blockerRows } = await pool.query(
    `SELECT
       COUNT(DISTINCT tl.target_task_id) AS blocked_tasks,
       COUNT(DISTINCT tl.target_task_id) FILTER (WHERE t.status = 'completed') AS resolved
     FROM task_links tl
     JOIN tasks t ON t.id = tl.target_task_id
     WHERE tl.workspace_id = $1
       AND tl.link_type    = 'is_blocked_by'
       AND t.assigned_to   = $2
       AND t.created_at   <= $4::timestamptz
       AND (t.updated_at BETWEEN $3::timestamptz AND $4::timestamptz OR t.status != 'completed')`,
    [workspaceId, userId, monthStart, monthEnd]
  );
  const blockedTotal    = Number(blockerRows[0]?.blocked_tasks || 0);
  const blockedResolved = Number(blockerRows[0]?.resolved      || 0);
  const blockerResolutionRatio = blockedTotal > 0
    ? blockedResolved / blockedTotal
    : 1; // no blocked tasks = perfect score

  /* ═══════════════════════════════════════════════════════════
     OUTPUT
  ═══════════════════════════════════════════════════════════ */
  return {
    metrics: {
      // Attendance
      hasAttendanceTracking: expectedWorkingDays > 0,  // always true when month has working days
      attendancePresenceRatio,
      attendanceHourQualityRatio,
      attendanceActiveTimeRatio,
      attendanceConsistencyRatio: consistencyRatio,
      // Productivity
      taskCompletionRatio,
      timelinessRatio,
      storyPointVelocityRatio,
      estimationAccuracyRatio,
      collaborationRatio,
      blockerResolutionRatio,
    },
    evidence: {
      presence:       `Present ${presentDays} of ${expectedWorkingDays} expected working days${holidayDates.size > 0 ? ` (${holidayDates.size} holiday${holidayDates.size > 1 ? "s" : ""} excluded)` : ""}${leaveDates.size > 0 ? `, ${leaveDates.size} leave day${leaveDates.size > 1 ? "s" : ""} excluded` : ""}`,
      hourQuality:    `Avg ${Math.round(avgSignedIn)} min/day signed in (target 480)`,
      activeTime:     avgAvailable > 0
        ? `Screen-on ${Math.round(avgScreenOn)} min of ${Math.round(avgAvailable)} min available`
        : "No screen-on data",
      consistency:    `Consistency ratio: ${(consistencyRatio * 100).toFixed(0)}%`,
      taskCompletion: `Completed ${completedTasks} of ${totalTasks} assigned tasks`,
      timeliness:     `${onTime} of ${tasksWithDue} deadline-tracked tasks on time${activeOverdueTL > 0 ? ` (${activeOverdueTL} still overdue)` : ""}`,
      storyPoints:    `${completedPoints} story points completed (target ${Math.round(pointsTarget)})`,
      estimation:     estimatedHoursCompleted > 0
        ? `Estimation accuracy: ${(estimationAccuracyRatio * 100).toFixed(0)}%`
        : "No estimation data — using neutral score",
      collaboration:  `${comments} comments + ${watched} tasks watched`,
      blockers:       blockedTotal > 0
        ? `Resolved ${blockedResolved} of ${blockedTotal} blocked tasks`
        : "No blocked tasks assigned",
    },
  };
}
