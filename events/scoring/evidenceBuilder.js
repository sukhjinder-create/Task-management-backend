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
     Source: daily_attendance (pre-aggregated by attendanceCalculation)
     Fallback: attendance_sessions (presence only)
  ═══════════════════════════════════════════════════════════ */

  // Rich daily data (screen time, hours, etc.)
  const { rows: dailyRows } = await pool.query(
    `SELECT
       COUNT(*)                                    AS present_days,
       AVG(total_signed_in_minutes)                AS avg_signed_in_min,
       AVG(screen_on_minutes)                      AS avg_screen_on_min,
       AVG(available_minutes)                      AS avg_available_min,
       ARRAY_AGG(EXTRACT(DOW FROM date)::int ORDER BY date) AS days_of_week
     FROM daily_attendance
     WHERE workspace_id = $1
       AND user_id      = $2
       AND date BETWEEN $3 AND $4`,
    [workspaceId, userId, monthStartStr, monthEndStr]
  );

  // Total working days = distinct dates any workspace member was present
  const { rows: workingDayRows } = await pool.query(
    `SELECT COUNT(DISTINCT date) AS working_days
     FROM daily_attendance
     WHERE workspace_id = $1
       AND date BETWEEN $2 AND $3`,
    [workspaceId, monthStartStr, monthEndStr]
  );

  const presentDays  = Number(dailyRows[0]?.present_days  || 0);
  const workingDays  = Number(workingDayRows[0]?.working_days || 0);
  const avgSignedIn  = Number(dailyRows[0]?.avg_signed_in_min  || 0);
  const avgScreenOn  = Number(dailyRows[0]?.avg_screen_on_min  || 0);
  const avgAvailable = Number(dailyRows[0]?.avg_available_min  || 0);
  const dowArray     = (dailyRows[0]?.days_of_week || []).map(Number);

  // ── Presence ─────────────────────────────────────────────
  const attendancePresenceRatio = workingDays > 0 ? presentDays / workingDays : 0;

  // ── Hour Quality (480 min = 8h expected) ─────────────────
  const EXPECTED_MINUTES = 480;
  const attendanceHourQualityRatio = presentDays > 0
    ? Math.min(avgSignedIn / EXPECTED_MINUTES, 1)
    : 0;

  // ── Active Time Ratio (screen-on / available) ─────────────
  const attendanceActiveTimeRatio = avgAvailable > 0
    ? Math.min(avgScreenOn / avgAvailable, 1)
    : (presentDays > 0 ? 0.5 : 0); // neutral if no screen data

  // ── Consistency (chronic DOW absence detection) ───────────
  // Count how many of each weekday (1=Mon…5=Fri) they were present
  // vs how many of those weekdays existed in the month
  let consistencyRatio = 1;
  if (workingDays >= 4 && presentDays > 0) {
    const dowCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const d of dowArray) {
      if (d >= 1 && d <= 5) dowCounts[d] = (dowCounts[d] || 0) + 1;
    }
    // Get total occurrences of each weekday in the month for the workspace
    const { rows: dowTotals } = await pool.query(
      `SELECT EXTRACT(DOW FROM date)::int AS dow, COUNT(DISTINCT date) AS cnt
       FROM daily_attendance
       WHERE workspace_id = $1
         AND date BETWEEN $2 AND $3
       GROUP BY 1`,
      [workspaceId, monthStartStr, monthEndStr]
    );
    const workspaceDow = {};
    for (const r of dowTotals) workspaceDow[r.dow] = Number(r.cnt);

    let absenceRatioSum = 0;
    let weekdays = 0;
    for (let d = 1; d <= 5; d++) {
      const total = workspaceDow[d] || 0;
      if (total === 0) continue;
      weekdays++;
      const present = dowCounts[d] || 0;
      absenceRatioSum += (total - present) / total;
    }
    if (weekdays > 0) {
      const avgAbsence = absenceRatioSum / weekdays;
      // Penalise uneven patterns: uniform absence = bad, spread = ok
      // If they're absent 40% of Mondays but 0% of other days → pattern
      const dowRatios = [];
      for (let d = 1; d <= 5; d++) {
        const total = workspaceDow[d] || 0;
        if (total === 0) continue;
        dowRatios.push(((workspaceDow[d] - (dowCounts[d] || 0)) / workspaceDow[d]));
      }
      const maxAbsence = Math.max(...dowRatios);
      // If worst day is >30% absent, penalise proportionally
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

  // ── Timeliness ────────────────────────────────────────────
  const { rows: timelinessRows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'completed')                        AS completed,
       COUNT(*) FILTER (
         WHERE status = 'completed'
           AND due_date IS NOT NULL
           AND updated_at <= due_date
       )                                                                    AS on_time
     FROM tasks
     WHERE workspace_id = $1
       AND assigned_to  = $2
       AND updated_at BETWEEN $3::timestamptz AND $4::timestamptz`,
    [workspaceId, userId, monthStart, monthEnd]
  );

  const completedWithDue = Number(timelinessRows[0]?.completed || 0);
  const onTime           = Number(timelinessRows[0]?.on_time   || 0);
  const timelinessRatio  = completedWithDue > 0 ? onTime / completedWithDue : 0;

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
    : (taskCompletionRatio > 0 ? taskCompletionRatio * 0.5 : 0); // fallback if no points set

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
  // Score: 5 comments = full; each watch = 0.5 comment equivalent
  const collaborationRatio = Math.min((comments + watched * 0.5) / 5, 1);

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
      presence:       `Present ${presentDays} of ${workingDays} working days`,
      hourQuality:    `Avg ${Math.round(avgSignedIn)} min/day signed in (target 480)`,
      activeTime:     avgAvailable > 0
        ? `Screen-on ${Math.round(avgScreenOn)} min of ${Math.round(avgAvailable)} min available`
        : "No screen-on data",
      consistency:    `Consistency ratio: ${(consistencyRatio * 100).toFixed(0)}%`,
      taskCompletion: `Completed ${completedTasks} of ${totalTasks} assigned tasks`,
      timeliness:     `${onTime} of ${completedWithDue} completed tasks were on time`,
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
