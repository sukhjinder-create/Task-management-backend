import pool from "../../db.js";

function getMonthRange(month) {
  // month = "YYYY-MM"
  const start = new Date(`${month}-01T00:00:00.000Z`);
  const end = new Date(start);
  end.setMonth(end.getMonth() + 1);
  end.setMilliseconds(-1); // last moment of month
  return { start, end };
}

/**
 * Build evidence + normalized metrics for a user in a month.
 * READ-ONLY. Deterministic.
 */
export async function buildUserEvidence({
  workspaceId,
  userId,
  month,
}) {
  const { start: monthStart, end: monthEnd } = getMonthRange(month);

  /* ===============================
     1️⃣ ATTENDANCE
  =============================== */
  const { rows: attendanceRows } = await pool.query(
    `
    SELECT
      COUNT(DISTINCT DATE(sign_in_at)) AS present_days
    FROM attendance_sessions
    WHERE workspace_id = $1
      AND user_id = $2
      AND sign_in_at BETWEEN $3::timestamptz AND $4::timestamptz
    `,
    [workspaceId, userId, monthStart, monthEnd]
  );

  const presentDays = Number(attendanceRows[0]?.present_days || 0);

  const { rows: totalDaysRows } = await pool.query(
    `
    SELECT
      COUNT(DISTINCT DATE(sign_in_at)) AS total_days
    FROM attendance_sessions
    WHERE workspace_id = $1
      AND sign_in_at BETWEEN $2::timestamptz AND $3::timestamptz
    `,
    [workspaceId, monthStart, monthEnd]
  );

  const totalDays = Number(totalDaysRows[0]?.total_days || 0);

  const attendanceRatio =
    totalDays > 0 ? presentDays / totalDays : 0;

  /* ===============================
     2️⃣ TASK COMPLETION
  =============================== */
  const { rows: taskRows } = await pool.query(
    `
    SELECT
      COUNT(*) FILTER (WHERE status = 'completed') AS completed_tasks,
      COUNT(*) AS total_tasks
    FROM tasks
    WHERE workspace_id = $1
      AND assigned_to = $2
      AND created_at BETWEEN $3::timestamptz AND $4::timestamptz
    `,
    [workspaceId, userId, monthStart, monthEnd]
  );

  const completedTasks = Number(taskRows[0]?.completed_tasks || 0);
  const totalTasks = Number(taskRows[0]?.total_tasks || 0);

  const taskCompletionRatio =
    totalTasks > 0 ? completedTasks / totalTasks : 0;

  /* ===============================
     3️⃣ TIMELINESS
  =============================== */
  const { rows: timelinessRows } = await pool.query(
    `
    SELECT
      COUNT(*) FILTER (
        WHERE status = 'completed'
          AND due_date IS NOT NULL
          AND updated_at <= due_date
      ) AS on_time,
      COUNT(*) FILTER (WHERE status = 'completed') AS completed
    FROM tasks
    WHERE workspace_id = $1
      AND assigned_to = $2
      AND updated_at BETWEEN $3::timestamptz AND $4::timestamptz
    `,
    [workspaceId, userId, monthStart, monthEnd]
  );

  const onTime = Number(timelinessRows[0]?.on_time || 0);
  const completed = Number(timelinessRows[0]?.completed || 0);

  const timelinessRatio =
    completed > 0 ? onTime / completed : 0;

  /* ===============================
     4️⃣ STABILITY (FIXED PARAM BUG)
  =============================== */
  const { rows: projectRows } = await pool.query(
    `
    SELECT COUNT(DISTINCT project_id) AS projects
    FROM tasks
    WHERE workspace_id = $1
      AND assigned_to = $2
      AND created_at <= $3::timestamptz
    `,
    [workspaceId, userId, monthEnd]
  );

  const projects = Number(projectRows[0]?.projects || 0);

  const stabilityRatio =
    projects <= 1 ? 1 :
    projects === 2 ? 0.8 :
    projects === 3 ? 0.6 :
    0.4;

  /* ===============================
     5️⃣ COLLABORATION (COMMENTS)
  =============================== */
  const { rows: commentRows } = await pool.query(
    `
    SELECT COUNT(*) AS comments
    FROM comments
    WHERE workspace_id = $1
      AND added_by = $2
      AND created_at BETWEEN $3::timestamptz AND $4::timestamptz
    `,
    [workspaceId, userId, monthStart, monthEnd]
  );

  const comments = Number(commentRows[0]?.comments || 0);

  const collaborationRatio = Math.min(comments / 5, 1);

  /* ===============================
     FINAL OUTPUT
  =============================== */
  return {
    metrics: {
      attendanceRatio,
      taskCompletionRatio,
      timelinessRatio,
      stabilityRatio,
      collaborationRatio,
    },
    evidence: {
      attendance: `Present ${presentDays} of ${totalDays} working days`,
      tasks: `Completed ${completedTasks} of ${totalTasks} assigned tasks`,
      timeliness: `${onTime} of ${completed} tasks completed on time`,
      stability: `Worked across ${projects} project(s)`,
      collaboration: `Posted ${comments} comment(s)`,
    },
  };
}