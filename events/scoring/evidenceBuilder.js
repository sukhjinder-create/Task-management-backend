import pool from "../../db.js";

const EXPECTED_DAILY_MINUTES = 480;

function getMonthRange(month) {
  const start = new Date(`${month}-01T00:00:00.000Z`);
  const endExclusive = new Date(start);
  endExclusive.setMonth(endExclusive.getMonth() + 1);
  const endInclusive = new Date(endExclusive.getTime() - 1);
  return { start, endExclusive, endInclusive };
}

function sumBy(rows, field) {
  return rows.reduce((sum, row) => sum + (Number(row[field]) || 0), 0);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function scoreWithUpperBound(value, healthyUpper, maxUpper) {
  if (value <= healthyUpper) return 1;
  if (value >= maxUpper) return 0;
  const span = maxUpper - healthyUpper;
  if (span <= 0) return 0;
  return clamp01(1 - ((value - healthyUpper) / span));
}

function buildExpectedWorkingDateSet({
  monthStart,
  monthEndInclusive,
  workDayNums,
  holidayDates,
  leaveDates,
}) {
  const expectedDates = new Set();
  const cursor = new Date(monthStart);

  while (cursor <= monthEndInclusive) {
    const dateKey = cursor.toISOString().slice(0, 10);
    const dow = cursor.getUTCDay();
    if (
      workDayNums.includes(dow)
      && !holidayDates.has(dateKey)
      && !leaveDates.has(dateKey)
    ) {
      expectedDates.add(dateKey);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return expectedDates;
}

function buildConsistencyRatio({ expectedWorkingDates, presentWorkingDates, workDayNums }) {
  if (expectedWorkingDates.size < 4) return null;

  const expectedDowCounts = Object.fromEntries(workDayNums.map((dow) => [dow, 0]));
  const presentDowCounts = Object.fromEntries(workDayNums.map((dow) => [dow, 0]));

  for (const dateKey of expectedWorkingDates) {
    const dow = new Date(`${dateKey}T00:00:00.000Z`).getUTCDay();
    expectedDowCounts[dow] = (expectedDowCounts[dow] || 0) + 1;
  }

  for (const dateKey of presentWorkingDates) {
    const dow = new Date(`${dateKey}T00:00:00.000Z`).getUTCDay();
    if (dow in presentDowCounts) {
      presentDowCounts[dow] = (presentDowCounts[dow] || 0) + 1;
    }
  }

  const absenceRatios = [];
  for (const dow of workDayNums) {
    const expected = expectedDowCounts[dow] || 0;
    if (expected <= 0) continue;
    const present = presentDowCounts[dow] || 0;
    const absent = Math.max(0, expected - present);
    absenceRatios.push(absent / expected);
  }

  if (absenceRatios.length === 0) return null;

  const maxAbsence = Math.max(...absenceRatios);
  const avgAbsence = absenceRatios.reduce((sum, value) => sum + value, 0) / absenceRatios.length;
  return clamp01(1 - (maxAbsence > 0.3 ? maxAbsence * 0.8 : avgAbsence * 0.5));
}

/**
 * Build rich evidence and normalized metrics for a user in a month.
 * Read-only, deterministic, and safe to re-run.
 */
export async function buildUserEvidence({ workspaceId, userId, month }) {
  const { start: monthStart, endExclusive: monthEndExclusive, endInclusive: monthEndInclusive } = getMonthRange(month);
  const monthStartStr = monthStart.toISOString().slice(0, 10);
  const monthEndStr = monthEndInclusive.toISOString().slice(0, 10);

  const { rows: scheduleRows } = await pool.query(
    `SELECT work_days FROM workspace_work_schedule WHERE workspace_id = $1`,
    [workspaceId]
  );
  const workDayNums = (scheduleRows[0]?.work_days || [1, 2, 3, 4, 5]).map(Number);

  const { rows: holidayRows } = await pool.query(
    `SELECT date::text AS date
     FROM workspace_holidays
     WHERE workspace_id = $1
       AND date BETWEEN $2 AND $3`,
    [workspaceId, monthStartStr, monthEndStr]
  );
  const holidayDates = new Set(holidayRows.map((row) => row.date.slice(0, 10)));

  const { rows: leaveRows } = await pool.query(
    `SELECT d::date::text AS day
     FROM leave_requests lr
     CROSS JOIN LATERAL generate_series(lr.start_date, lr.end_date, '1 day'::interval) d
     WHERE lr.workspace_id = $1
       AND lr.user_id = $2
       AND lr.status = 'approved'
       AND lr.end_date >= $3
       AND lr.start_date <= $4`,
    [workspaceId, userId, monthStartStr, monthEndStr]
  );
  const leaveDates = new Set(leaveRows.map((row) => row.day.slice(0, 10)));

  const expectedWorkingDates = buildExpectedWorkingDateSet({
    monthStart,
    monthEndInclusive,
    workDayNums,
    holidayDates,
    leaveDates,
  });
  const expectedWorkingDays = expectedWorkingDates.size;

  const { rows: attendanceRows } = await pool.query(
    `SELECT
       date::text AS date,
       COALESCE(signed_in_minutes, 0)::int AS signed_in_minutes,
       COALESCE(available_minutes, 0)::int AS available_minutes,
       COALESCE(aws_minutes, 0)::int AS aws_minutes,
       COALESCE(lunch_minutes, 0)::int AS lunch_minutes,
       COALESCE(screen_on_minutes, 0)::int AS screen_on_minutes,
       COALESCE(screen_off_minutes, 0)::int AS screen_off_minutes
     FROM attendance_daily
     WHERE workspace_id = $1
       AND user_id = $2
       AND date BETWEEN $3 AND $4
     ORDER BY date ASC`,
    [workspaceId, userId, monthStartStr, monthEndStr]
  );

  const { rows: attendanceEventRows } = await pool.query(
    `SELECT event_type, COUNT(*)::int AS count
     FROM attendance_events
     WHERE workspace_id = $1
       AND user_id = $2
       AND started_at >= $3::timestamptz
       AND started_at < $4::timestamptz
     GROUP BY event_type`,
    [workspaceId, userId, monthStart, monthEndExclusive]
  );
  const attendanceEventCounts = Object.fromEntries(
    attendanceEventRows.map((row) => [row.event_type, Number(row.count) || 0])
  );

  const { rows: workspaceAttendanceRows } = await pool.query(
    `SELECT COUNT(*)::int AS event_count
     FROM attendance_events
     WHERE workspace_id = $1
       AND started_at >= $2::timestamptz
       AND started_at < $3::timestamptz`,
    [workspaceId, monthStart, monthEndExclusive]
  );
  const workspaceAttendanceActive = Number(workspaceAttendanceRows[0]?.event_count || 0) > 0;

  const workingDayAttendanceRows = attendanceRows.filter((row) => expectedWorkingDates.has(row.date.slice(0, 10)));
  const presentWorkingDayRows = workingDayAttendanceRows.filter((row) => Number(row.signed_in_minutes) > 0);
  const presentWorkingDates = new Set(presentWorkingDayRows.map((row) => row.date.slice(0, 10)));

  const presentWorkingDays = presentWorkingDayRows.length;
  const totalSignedInMinutes = sumBy(presentWorkingDayRows, "signed_in_minutes");
  const totalAvailableMinutes = sumBy(presentWorkingDayRows, "available_minutes");
  const totalAwsMinutes = sumBy(presentWorkingDayRows, "aws_minutes");
  const totalLunchMinutes = sumBy(presentWorkingDayRows, "lunch_minutes");

  const totalPresenceEvents = [
    "SIGN_IN",
    "SIGN_OFF",
    "AVAILABLE",
    "AWS_START",
    "AWS_END",
    "LUNCH_START",
    "LUNCH_END",
  ].reduce((sum, type) => sum + (attendanceEventCounts[type] || 0), 0);

  const awsStarts = attendanceEventCounts.AWS_START || 0;
  const lunchStarts = attendanceEventCounts.LUNCH_START || 0;
  const userHasAttendanceTelemetry = attendanceRows.length > 0 || totalPresenceEvents > 0;
  const hasAttendanceTracking = expectedWorkingDays > 0 && workspaceAttendanceActive;
  const attendanceTelemetryStatus = !workspaceAttendanceActive
    ? "missing"
    : userHasAttendanceTelemetry
      ? "tracked"
      : "absent";

  const attendancePresenceRatio = hasAttendanceTracking && expectedWorkingDays > 0
    ? clamp01(presentWorkingDays / expectedWorkingDays)
    : null;

  const attendanceHourQualityRatio = hasAttendanceTracking
    ? (
      presentWorkingDays > 0
        ? clamp01(totalSignedInMinutes / (presentWorkingDays * EXPECTED_DAILY_MINUTES))
        : 0
    )
    : null;

  const attendanceAvailabilityRatio = hasAttendanceTracking
    ? (totalSignedInMinutes > 0 ? clamp01(totalAvailableMinutes / totalSignedInMinutes) : 0)
    : null;

  const awsMinutesPerPresentDay = presentWorkingDays > 0 ? totalAwsMinutes / presentWorkingDays : 0;
  const awsStartsPerPresentDay = presentWorkingDays > 0 ? awsStarts / presentWorkingDays : 0;
  const attendanceAwsDisciplineRatio = hasAttendanceTracking
    ? (
      presentWorkingDays > 0
        ? clamp01(
          (scoreWithUpperBound(awsMinutesPerPresentDay, 45, 180) * 0.7)
          + (scoreWithUpperBound(awsStartsPerPresentDay, 1, 4) * 0.3)
        )
        : 0
    )
    : null;

  const lunchMinutesPerPresentDay = presentWorkingDays > 0 ? totalLunchMinutes / presentWorkingDays : 0;
  const lunchStartsPerPresentDay = presentWorkingDays > 0 ? lunchStarts / presentWorkingDays : 0;
  const attendanceLunchDisciplineRatio = hasAttendanceTracking
    ? (
      presentWorkingDays > 0
        ? clamp01(
          (scoreWithUpperBound(lunchMinutesPerPresentDay, 90, 180) * 0.7)
          + (scoreWithUpperBound(lunchStartsPerPresentDay, 1.25, 3) * 0.3)
        )
        : 0
    )
    : null;

  const attendanceConsistencyRatio = hasAttendanceTracking
    ? (buildConsistencyRatio({
      expectedWorkingDates,
      presentWorkingDates,
      workDayNums,
    }) ?? 1)
    : null;

  const { rows: taskRows } = await pool.query(
    `SELECT
       COUNT(*) AS total_tasks,
       COUNT(*) FILTER (WHERE status = 'completed') AS completed_tasks,
       COALESCE(SUM(story_points) FILTER (WHERE status = 'completed'), 0) AS completed_points,
       COALESCE(SUM(estimation_hours) FILTER (
         WHERE status = 'completed' AND estimation_hours IS NOT NULL
       ), 0) AS estimated_hours_completed
     FROM tasks
     WHERE workspace_id = $1
       AND assigned_to = $2
       AND created_at >= $3::timestamptz
       AND created_at < $4::timestamptz`,
    [workspaceId, userId, monthStart, monthEndExclusive]
  );

  const totalTasks = Number(taskRows[0]?.total_tasks || 0);
  const completedTasks = Number(taskRows[0]?.completed_tasks || 0);
  const completedPoints = Number(taskRows[0]?.completed_points || 0);
  const estimatedHoursCompleted = Number(taskRows[0]?.estimated_hours_completed || 0);
  const taskCompletionRatio = totalTasks > 0 ? completedTasks / totalTasks : 0;

  const { rows: timelinessRows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE due_date IS NOT NULL) AS tasks_with_due,
       COUNT(*) FILTER (
         WHERE status = 'completed'
           AND due_date IS NOT NULL
           AND completed_at IS NOT NULL
           AND completed_at <= due_date
       ) AS on_time,
       COUNT(*) FILTER (
         WHERE due_date IS NOT NULL
           AND status != 'completed'
           AND due_date < NOW()
       ) AS active_overdue
     FROM tasks
     WHERE workspace_id = $1
       AND assigned_to = $2
       AND created_at >= $3::timestamptz
       AND created_at < $4::timestamptz`,
    [workspaceId, userId, monthStart, monthEndExclusive]
  );

  const tasksWithDue = Number(timelinessRows[0]?.tasks_with_due || 0);
  const onTime = Number(timelinessRows[0]?.on_time || 0);
  const activeOverdueTL = Number(timelinessRows[0]?.active_overdue || 0);
  const timelinessRatio = completedTasks === 0
    ? 0
    : tasksWithDue > 0
      ? onTime / tasksWithDue
      : 0.5;

  const { rows: wsPointsRows } = await pool.query(
    `SELECT AVG(pts) AS avg_pts FROM (
       SELECT assigned_to, SUM(story_points) AS pts
       FROM tasks
       WHERE workspace_id = $1
         AND status = 'completed'
         AND created_at >= $2::timestamptz
         AND created_at < $3::timestamptz
         AND story_points IS NOT NULL
       GROUP BY assigned_to
     ) sub`,
    [workspaceId, monthStart, monthEndExclusive]
  );
  const wsAvgPoints = Number(wsPointsRows[0]?.avg_pts || 0);
  const pointsTarget = wsAvgPoints > 0 ? wsAvgPoints : 40;
  const storyPointVelocityRatio = completedTasks === 0
    ? 0
    : completedPoints > 0
      ? Math.min(completedPoints / pointsTarget, 1)
      : taskCompletionRatio;

  let actualHours = 0;
  let estimationAccuracyRatio = 0.5;
  if (estimatedHoursCompleted > 0) {
    const { rows: timeLogRows } = await pool.query(
      `SELECT COALESCE(SUM(tl.hours), 0) AS actual_hours
       FROM time_logs tl
       JOIN tasks t ON t.id = tl.task_id
       WHERE tl.workspace_id = $1
         AND tl.user_id = $2
         AND t.status = 'completed'
         AND tl.log_date BETWEEN $3 AND $4`,
      [workspaceId, userId, monthStartStr, monthEndStr]
    );
    actualHours = Number(timeLogRows[0]?.actual_hours || 0);
    if (actualHours > 0) {
      const deviation = Math.abs(actualHours - estimatedHoursCompleted)
        / Math.max(actualHours, estimatedHoursCompleted);
      estimationAccuracyRatio = Math.max(0, 1 - deviation);
    }
  }

  const { rows: commentRows } = await pool.query(
    `SELECT COUNT(*) AS comments
     FROM comments
     WHERE workspace_id = $1
       AND added_by = $2
       AND created_at >= $3::timestamptz
       AND created_at < $4::timestamptz`,
    [workspaceId, userId, monthStart, monthEndExclusive]
  );
  const comments = Number(commentRows[0]?.comments || 0);

  const { rows: watcherRows } = await pool.query(
    `SELECT COUNT(*) AS watched
     FROM task_watchers
     WHERE workspace_id = $1
       AND user_id = $2
       AND created_at >= $3::timestamptz
       AND created_at < $4::timestamptz`,
    [workspaceId, userId, monthStart, monthEndExclusive]
  );
  const watched = Number(watcherRows[0]?.watched || 0);

  const collaborationSignals = comments + watched * 0.5;
  const collaborationRatio = collaborationSignals === 0
    ? 0.5
    : Math.min(collaborationSignals / 5, 1);

  const { rows: blockerRows } = await pool.query(
    `SELECT
       COUNT(DISTINCT tl.target_task_id) AS blocked_tasks,
       COUNT(DISTINCT tl.target_task_id) FILTER (WHERE t.status = 'completed') AS resolved
     FROM task_links tl
     JOIN tasks t ON t.id = tl.target_task_id
     WHERE tl.workspace_id = $1
       AND tl.link_type = 'is_blocked_by'
       AND t.assigned_to = $2
       AND t.created_at <= $4::timestamptz
       AND (
         t.updated_at >= $3::timestamptz
         AND t.updated_at < $4::timestamptz
         OR t.status != 'completed'
       )`,
    [workspaceId, userId, monthStart, monthEndExclusive]
  );
  const blockedTotal = Number(blockerRows[0]?.blocked_tasks || 0);
  const blockedResolved = Number(blockerRows[0]?.resolved || 0);
  const blockerResolutionRatio = completedTasks === 0
    ? 0
    : blockedTotal > 0
      ? blockedResolved / blockedTotal
      : 1;

  const isInactive = presentWorkingDays === 0
    && completedTasks === 0
    && comments === 0
    && watched === 0
    && actualHours === 0;

  return {
    metrics: {
      isInactive,
      hasAttendanceTracking,
      attendanceTelemetryStatus,
      attendancePresenceRatio,
      attendanceHourQualityRatio,
      attendanceAvailabilityRatio,
      attendanceAwsDisciplineRatio,
      attendanceLunchDisciplineRatio,
      attendanceConsistencyRatio,
      taskCompletionRatio,
      timelinessRatio,
      storyPointVelocityRatio,
      estimationAccuracyRatio,
      collaborationRatio,
      blockerResolutionRatio,
    },
    evidence: {
      presence: `Present ${presentWorkingDays} of ${expectedWorkingDays} expected working days${holidayDates.size > 0 ? ` (${holidayDates.size} holiday${holidayDates.size > 1 ? "s" : ""} excluded)` : ""}${leaveDates.size > 0 ? `, ${leaveDates.size} leave day${leaveDates.size > 1 ? "s" : ""} excluded` : ""}`,
      hourQuality: presentWorkingDays > 0
        ? `Signed in ${Math.round(totalSignedInMinutes / presentWorkingDays)} min/day on average (target ${EXPECTED_DAILY_MINUTES})`
        : "No working-day sign-ins captured",
      availability: totalSignedInMinutes > 0
        ? `Available ${Math.round(totalAvailableMinutes)} of ${Math.round(totalSignedInMinutes)} signed-in minutes`
        : "No signed-in availability data",
      aws: awsStarts > 0 || totalAwsMinutes > 0
        ? `AWS used ${awsStarts} time(s), ${Math.round(totalAwsMinutes)} total min`
        : "No AWS time recorded",
      lunch: lunchStarts > 0 || totalLunchMinutes > 0
        ? `Lunch taken ${lunchStarts} time(s), ${Math.round(totalLunchMinutes)} total min`
        : "No lunch time recorded",
      consistency: attendanceConsistencyRatio != null
        ? `Attendance consistency ${(attendanceConsistencyRatio * 100).toFixed(0)}% across expected working days`
        : "Consistency not scored for very short calendars",
      taskCompletion: `Completed ${completedTasks} of ${totalTasks} assigned tasks`,
      timeliness: `${onTime} of ${tasksWithDue} deadline-tracked tasks on time${activeOverdueTL > 0 ? ` (${activeOverdueTL} still overdue)` : ""}`,
      storyPoints: `${completedPoints} story points completed (target ${Math.round(pointsTarget)})`,
      estimation: estimatedHoursCompleted > 0
        ? `Estimation accuracy ${(estimationAccuracyRatio * 100).toFixed(0)}%`
        : "No estimation data - using neutral score",
      collaboration: `${comments} comments + ${watched} tasks watched`,
      blockers: blockedTotal > 0
        ? `Resolved ${blockedResolved} of ${blockedTotal} blocked tasks`
        : "No blocked tasks assigned",
    },
  };
}
