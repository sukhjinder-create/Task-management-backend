import pool from "../../db.js";
import { getRangeFromWindow, getWorkspaceCalendar } from "./calendar.service.js";

const COMPLETED_STATUSES = ["completed", "done", "closed"];
const OPEN_STATUSES = ["pending", "in-progress", "in_progress", "backlog"];

function dateKey(value) {
  return value ? String(value).slice(0, 10) : null;
}

function minDateKey(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return a <= b ? a : b;
}

function emptyCalendar() {
  return {
    workDayNums: [],
    holidayDates: new Set(),
    leaveCapacityByDate: new Map(),
    dayContexts: [],
    expectedWorkingDays: [],
    nonWorkingDays: [],
    holidayCount: 0,
    approvedLeaveDays: 0,
  };
}

function rowsByDate(rows = [], field = "date") {
  const map = new Map();
  for (const row of rows) {
    const key = dateKey(row[field]);
    if (!key) continue;
    map.set(key, row);
  }
  return map;
}

export async function collectUserEvidence({ workspaceId, userId, windowDays = 30, now = new Date() }) {
  const range = getRangeFromWindow(windowDays, now);
  const priorEnd = new Date(range.start);
  priorEnd.setUTCDate(priorEnd.getUTCDate() - 1);
  priorEnd.setUTCHours(23, 59, 59, 999);
  const priorStart = new Date(priorEnd);
  priorStart.setUTCDate(priorStart.getUTCDate() - range.windowDays + 1);
  priorStart.setUTCHours(0, 0, 0, 0);

  const { rows: attendanceCloseRows } = await pool.query(
    `SELECT MAX(date)::text AS closed_through
     FROM attendance_daily
     WHERE workspace_id = $1
       AND date BETWEEN $2 AND $3`,
    [workspaceId, range.startDate, range.endDate]
  ).catch(() => ({ rows: [] }));

  const attendanceClosedThroughDate = dateKey(attendanceCloseRows[0]?.closed_through);
  const attendanceCoverageEndDate = minDateKey(range.endDate, attendanceClosedThroughDate);
  const attendanceCoverageStartDate = attendanceCoverageEndDate ? range.startDate : null;
  const calendar = attendanceCoverageEndDate
    ? await getWorkspaceCalendar({
      workspaceId,
      userId,
      startDate: attendanceCoverageStartDate,
      endDate: attendanceCoverageEndDate,
    })
    : emptyCalendar();

  const [
    attendance,
    attendanceEvents,
    tasks,
    priorTasks,
    timeLogs,
    comments,
    watchers,
    taskLinks,
    reviews,
    activity,
  ] = await Promise.all([
    pool.query(
      `SELECT *
       FROM attendance_daily
       WHERE workspace_id = $1
         AND user_id = $2
         AND date BETWEEN $3 AND $4
       ORDER BY date ASC`,
      [workspaceId, userId, attendanceCoverageStartDate || range.startDate, attendanceCoverageEndDate || range.startDate]
    ).then((r) => r.rows).catch(() => []),
    pool.query(
      `SELECT event_type, started_at, ended_at
       FROM attendance_events
       WHERE workspace_id = $1
         AND user_id = $2
         AND started_at >= $3::timestamptz
         AND started_at <= $4::timestamptz
       ORDER BY started_at ASC`,
      [
        workspaceId,
        userId,
        attendanceCoverageStartDate ? `${attendanceCoverageStartDate}T00:00:00.000Z` : range.start,
        attendanceCoverageEndDate ? `${attendanceCoverageEndDate}T23:59:59.999Z` : range.start,
      ]
    ).then((r) => r.rows).catch(() => []),
    pool.query(
      `SELECT *
       FROM tasks
       WHERE workspace_id = $1
         AND (
           assigned_to = $2
           OR added_by = $2::text
         )
         AND created_at <= $4::timestamptz
         AND (
           created_at >= $3::timestamptz
           OR updated_at >= $3::timestamptz
           OR status NOT IN ('completed', 'done', 'closed', 'cancelled')
         )`,
      [workspaceId, userId, range.start, range.end]
    ).then((r) => r.rows).catch(() => []),
    pool.query(
      `SELECT *
       FROM tasks
       WHERE workspace_id = $1
         AND assigned_to = $2
         AND created_at >= $3::timestamptz
         AND created_at <= $4::timestamptz`,
      [workspaceId, userId, priorStart, priorEnd]
    ).then((r) => r.rows).catch(() => []),
    pool.query(
      `SELECT tl.*, t.project_id, t.status, t.estimation_hours, t.completed_at
       FROM time_logs tl
       JOIN tasks t ON t.id = tl.task_id
       WHERE tl.workspace_id = $1
         AND tl.user_id = $2
         AND tl.log_date BETWEEN $3 AND $4`,
      [workspaceId, userId, range.startDate, range.endDate]
    ).then((r) => r.rows).catch(() => []),
    pool.query(
      `SELECT c.*, t.project_id, t.assigned_to
       FROM comments c
       JOIN tasks t ON t.id = c.task_id
       WHERE t.workspace_id = $1
         AND c.added_by = $2
         AND c.created_at >= $3::timestamptz
         AND c.created_at <= $4::timestamptz`,
      [workspaceId, userId, range.start, range.end]
    ).then((r) => r.rows).catch(() => []),
    pool.query(
      `SELECT tw.*, t.project_id
       FROM task_watchers tw
       JOIN tasks t ON t.id = tw.task_id
       WHERE tw.workspace_id = $1
         AND tw.user_id = $2
         AND tw.created_at >= $3::timestamptz
         AND tw.created_at <= $4::timestamptz`,
      [workspaceId, userId, range.start, range.end]
    ).then((r) => r.rows).catch(() => []),
    pool.query(
      `SELECT tl.*, t.assigned_to, t.status, t.completed_at
       FROM task_links tl
       JOIN tasks t ON t.id = tl.target_task_id
       WHERE tl.workspace_id = $1
         AND t.assigned_to = $2
         AND tl.created_at <= $4::timestamptz
         AND (
           tl.created_at >= $3::timestamptz
           OR t.updated_at >= $3::timestamptz
           OR t.status NOT IN ('completed', 'done', 'closed')
         )`,
      [workspaceId, userId, range.start, range.end]
    ).then((r) => r.rows).catch(() => []),
    pool.query(
      `SELECT pr.*, rc.start_date, rc.end_date
       FROM performance_reviews pr
       JOIN review_cycles rc ON rc.id = pr.cycle_id
       WHERE rc.workspace_id = $1
         AND (pr.reviewee_id = $2 OR pr.reviewer_id = $2)
         AND rc.end_date >= $3::date
         AND rc.start_date <= $4::date`,
      [workspaceId, userId, range.startDate, range.endDate]
    ).then((r) => r.rows).catch(() => []),
    pool.query(
      `SELECT *
       FROM task_activity_logs
       WHERE workspace_id = $1
         AND actor_id = $2
         AND created_at >= $3::timestamptz
         AND created_at <= $4::timestamptz`,
      [workspaceId, userId, range.start, range.end]
    ).then((r) => r.rows).catch(() => []),
  ]);

  const attendanceByDate = rowsByDate(attendance);
  const deliveryByDate = new Map();
  for (const task of tasks) {
    if (
      String(task.assigned_to || "") === String(userId) &&
      COMPLETED_STATUSES.includes(String(task.status || "").toLowerCase()) &&
      task.completed_at
    ) {
      const key = dateKey(task.completed_at);
      if (!key) continue;
      const existing = deliveryByDate.get(key) || { completedTasks: 0, storyPoints: 0, blockerResolutions: 0 };
      existing.completedTasks += 1;
      existing.storyPoints += Number(task.story_points) || 0;
      deliveryByDate.set(key, existing);
    }
  }
  for (const log of timeLogs) {
    const key = dateKey(log.log_date);
    if (!key) continue;
    const existing = deliveryByDate.get(key) || { completedTasks: 0, storyPoints: 0, blockerResolutions: 0 };
    existing.timeLogHours = (existing.timeLogHours || 0) + (Number(log.hours) || 0);
    deliveryByDate.set(key, existing);
  }
  for (const link of taskLinks) {
    if (!COMPLETED_STATUSES.includes(String(link.status || "").toLowerCase()) || !link.completed_at) continue;
    const key = dateKey(link.completed_at);
    if (!key) continue;
    const existing = deliveryByDate.get(key) || { completedTasks: 0, storyPoints: 0, blockerResolutions: 0 };
    existing.blockerResolutions = (existing.blockerResolutions || 0) + 1;
    deliveryByDate.set(key, existing);
  }

  return {
    workspaceId,
    userId,
    range,
    priorRange: {
      start: priorStart,
      end: priorEnd,
      startDate: priorStart.toISOString().slice(0, 10),
      endDate: priorEnd.toISOString().slice(0, 10),
    },
    calendar,
    attendanceClosedThroughDate,
    attendanceCoverage: {
      startDate: attendanceCoverageStartDate,
      endDate: attendanceCoverageEndDate,
    },
    attendance,
    attendanceByDate,
    attendanceEvents,
    tasks,
    priorTasks,
    timeLogs,
    comments,
    watchers,
    taskLinks,
    reviews,
    activity,
    deliveryByDate,
    statusSets: { completed: COMPLETED_STATUSES, open: OPEN_STATUSES },
  };
}

export async function collectProjectEvidence({ workspaceId, projectId, windowDays = 30, now = new Date() }) {
  const range = getRangeFromWindow(windowDays, now);
  const { rows: tasks } = await pool.query(
    `SELECT *
     FROM tasks
     WHERE workspace_id = $1
       AND project_id = $2
       AND created_at <= $4::timestamptz
       AND (
         created_at >= $3::timestamptz
         OR updated_at >= $3::timestamptz
         OR status NOT IN ('completed', 'done', 'closed', 'cancelled')
       )`,
    [workspaceId, projectId, range.start, range.end]
  ).catch(() => ({ rows: [] }));

  const { rows: links } = await pool.query(
    `SELECT tl.*
     FROM task_links tl
     JOIN tasks t ON t.id = tl.source_task_id OR t.id = tl.target_task_id
     WHERE tl.workspace_id = $1
       AND t.project_id = $2
       AND tl.created_at <= $3::timestamptz`,
    [workspaceId, projectId, range.end]
  ).catch(() => ({ rows: [] }));

  const { rows: sprints } = await pool.query(
    `SELECT *
     FROM sprints
     WHERE workspace_id = $1
       AND project_id = $2
       AND created_at <= $4::timestamptz
       AND (created_at >= $3::timestamptz OR updated_at >= $3::timestamptz OR status != 'completed')`,
    [workspaceId, projectId, range.start, range.end]
  ).catch(() => ({ rows: [] }));

  return {
    workspaceId,
    projectId,
    range,
    tasks,
    links,
    sprints,
    statusSets: { completed: COMPLETED_STATUSES, open: OPEN_STATUSES },
  };
}

export async function collectWorkspaceScope({ workspaceId }) {
  const [users, projects, managers] = await Promise.all([
    pool.query(
      `SELECT DISTINCT wu.user_id AS id, u.username, COALESCE(wu.role, u.role) AS role, wu.manager_id
       FROM workspace_users wu
       JOIN users u ON u.id = wu.user_id
       WHERE wu.workspace_id = $1
         AND COALESCE(u.is_system, false) = false
         AND COALESCE(u.role, '') != 'system'
         AND COALESCE(u.role, '') != 'superadmin'`,
      [workspaceId]
    ).then((r) => r.rows).catch(() => []),
    pool.query(
      `SELECT id, name FROM projects WHERE workspace_id = $1`,
      [workspaceId]
    ).then((r) => r.rows).catch(() => []),
    pool.query(
      `SELECT DISTINCT manager_id
       FROM workspace_users
       WHERE workspace_id = $1
         AND manager_id IS NOT NULL`,
      [workspaceId]
    ).then((r) => r.rows).catch(() => []),
  ]);

  return {
    users,
    projects,
    managers: managers.map((row) => row.manager_id).filter(Boolean),
  };
}

export async function collectWorkspaceEvidence({ workspaceId, windowDays = 30, now = new Date() }) {
  const range = getRangeFromWindow(windowDays, now);
  const [internal, external, externalSignals] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (
           WHERE LOWER(COALESCE(status, '')) = ANY($2::text[])
             AND completed_at IS NOT NULL
             AND completed_at <= $4::timestamptz
         )::int AS completed
       FROM tasks
       WHERE workspace_id = $1
         AND created_at <= $4::timestamptz
         AND (
           created_at >= $3::timestamptz
           OR updated_at >= $3::timestamptz
           OR status NOT IN ('completed', 'done', 'closed', 'cancelled')
           OR completed_at BETWEEN $3::timestamptz AND $4::timestamptz
         )`,
      [workspaceId, COMPLETED_STATUSES, range.start, range.end]
    ).then((r) => r.rows[0]).catch(() => ({ total: 0, completed: 0 })),
    pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(DISTINCT provider)::int AS provider_count
       FROM integration_entity_state
       WHERE workspace_id = $1
         AND updated_at <= $2::timestamptz`,
      [workspaceId, range.end]
    ).then((r) => r.rows[0]).catch(() => ({ total: 0, provider_count: 0 })),
    pool.query(
      `SELECT
         COUNT(*)::int AS signal_count,
         COUNT(DISTINCT external_id) FILTER (WHERE signal_type = 'INTEGRATION_TASK_COMPLETED')::int AS completed
       FROM workspace_execution_signals
       WHERE workspace_id = $1
         AND created_at >= $2::timestamptz
         AND created_at <= $3::timestamptz`,
      [workspaceId, range.start, range.end]
    ).then((r) => r.rows[0]).catch(() => ({ signal_count: 0, completed: 0 })),
  ]);

  const internalTotal = Number(internal?.total) || 0;
  const internalCompleted = Number(internal?.completed) || 0;
  const externalTotal = Number(external?.total) || 0;
  const externalCompleted = Math.min(Number(externalSignals?.completed) || 0, externalTotal);
  const totalWork = internalTotal + externalTotal;
  const completedWork = internalCompleted + externalCompleted;

  return {
    execution: {
      internalTotal,
      internalCompleted,
      externalTotal,
      externalCompleted,
      totalWork,
      completedWork,
      externalProviderCount: Number(external?.provider_count) || 0,
      externalSignalCount: Number(externalSignals?.signal_count) || 0,
    },
    sourceWindow: {
      startDate: range.startDate,
      endDate: range.endDate,
      windowDays: range.windowDays,
    },
  };
}
