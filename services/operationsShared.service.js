import pool from "../db.js";

const existenceCache = {
  tables: new Map(),
  columns: new Map(),
};

export function toDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().slice(0, 10);
}

export function getCurrentMonthKey() {
  return new Date().toISOString().slice(0, 7);
}

export function addDays(dateLike, days) {
  const date = dateLike instanceof Date ? new Date(dateLike) : new Date(dateLike);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

export function stripHtml(value = "") {
  return String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export async function tableExists(tableName) {
  if (existenceCache.tables.has(tableName)) {
    return existenceCache.tables.get(tableName);
  }

  const { rows } = await pool.query(
    `
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = $1
    ) AS exists
    `,
    [tableName]
  );

  const exists = rows[0]?.exists === true;
  existenceCache.tables.set(tableName, exists);
  return exists;
}

export async function columnExists(tableName, columnName) {
  const cacheKey = `${tableName}.${columnName}`;
  if (existenceCache.columns.has(cacheKey)) {
    return existenceCache.columns.get(cacheKey);
  }

  const { rows } = await pool.query(
    `
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2
    ) AS exists
    `,
    [tableName, columnName]
  );

  const exists = rows[0]?.exists === true;
  existenceCache.columns.set(cacheKey, exists);
  return exists;
}

export async function getWorkspaceUsers(workspaceId) {
  const { rows } = await pool.query(
    `
    SELECT
      u.id,
      u.username,
      u.email,
      u.role,
      u.projects,
      u.avatar_url,
      wu.manager_id,
      wu.billing_status
    FROM users u
    JOIN workspace_users wu
      ON wu.user_id = u.id
     AND wu.workspace_id = $1
    WHERE (u.is_system IS NULL OR u.is_system = FALSE)
      AND u.role != 'system'
      AND wu.billing_status != 'pending'
    ORDER BY u.username ASC
    `,
    [workspaceId]
  );

  return rows;
}

export async function resolveOperationsScope({ workspaceId, userId, role }) {
  if (role === "admin" || role === "owner") {
    const { rows } = await pool.query(
      `SELECT id, name FROM projects WHERE workspace_id = $1 ORDER BY created_at DESC`,
      [workspaceId]
    );

    return {
      scopeType: "workspace",
      scopeLabel: "Workspace",
      projects: rows,
      projectIds: rows.map((row) => row.id),
    };
  }

  if (role === "manager") {
    const { rows } = await pool.query(
      `
      SELECT p.id, p.name
      FROM projects p
      JOIN users u ON u.id = $2
      WHERE p.workspace_id = $1
        AND p.id = ANY(u.projects)
      ORDER BY p.created_at DESC
      `,
      [workspaceId, userId]
    );

    return {
      scopeType: "managed_projects",
      scopeLabel: "Managed Projects",
      projects: rows,
      projectIds: rows.map((row) => row.id),
    };
  }

  const { rows } = await pool.query(
    `
    SELECT DISTINCT p.id, p.name
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    WHERE t.workspace_id = $1
      AND t.assigned_to = $2
    ORDER BY p.name ASC
    `,
    [workspaceId, userId]
  );

  return {
    scopeType: "self",
    scopeLabel: "My Work",
    projects: rows,
    projectIds: rows.map((row) => row.id),
  };
}

export async function getWorkspaceCalendar(workspaceId, startDate, endDate) {
  const start = toDateKey(startDate);
  const end = toDateKey(endDate);

  const hasSchedule = await tableExists("workspace_work_schedule");
  const hasHolidays = await tableExists("workspace_holidays");

  const [{ rows: scheduleRows }, { rows: holidayRows }] = await Promise.all([
    hasSchedule
      ? pool.query(
        `SELECT work_days FROM workspace_work_schedule WHERE workspace_id = $1 LIMIT 1`,
        [workspaceId]
      )
      : Promise.resolve({ rows: [] }),
    hasHolidays
      ? pool.query(
        `
        SELECT date::text AS date
        FROM workspace_holidays
        WHERE workspace_id = $1
          AND date BETWEEN $2 AND $3
        `,
        [workspaceId, start, end]
      )
      : Promise.resolve({ rows: [] }),
  ]);

  return {
    workDayNums: (scheduleRows[0]?.work_days || [1, 2, 3, 4, 5]).map(Number),
    holidayDates: new Set(holidayRows.map((row) => row.date.slice(0, 10))),
  };
}

export async function getApprovedLeaveDateMap(workspaceId, startDate, endDate, userIds = null) {
  if (!(await tableExists("leave_requests"))) {
    return new Map();
  }

  const params = [workspaceId, toDateKey(startDate), toDateKey(endDate)];
  let userFilter = "";

  if (Array.isArray(userIds) && userIds.length > 0) {
    params.push(userIds);
    userFilter = ` AND lr.user_id = ANY($4)`;
  }

  const { rows } = await pool.query(
    `
    SELECT lr.user_id, d::date::text AS day
    FROM leave_requests lr
    CROSS JOIN LATERAL generate_series(lr.start_date, lr.end_date, '1 day'::interval) d
    WHERE lr.workspace_id = $1
      AND lr.status = 'approved'
      AND lr.end_date >= $2
      AND lr.start_date <= $3
      ${userFilter}
    `,
    params
  );

  const leaveMap = new Map();
  for (const row of rows) {
    if (!leaveMap.has(row.user_id)) {
      leaveMap.set(row.user_id, new Set());
    }
    leaveMap.get(row.user_id).add(row.day.slice(0, 10));
  }

  return leaveMap;
}

export function buildExpectedWorkingDates({
  startDate,
  endDate,
  workDayNums,
  holidayDates,
  excludedDates = new Set(),
}) {
  const expectedDates = [];
  const cursor = new Date(`${toDateKey(startDate)}T00:00:00.000Z`);
  const limit = new Date(`${toDateKey(endDate)}T00:00:00.000Z`);

  while (cursor <= limit) {
    const dateKey = toDateKey(cursor);
    const dow = cursor.getUTCDay();
    if (
      workDayNums.includes(dow)
      && !holidayDates.has(dateKey)
      && !excludedDates.has(dateKey)
    ) {
      expectedDates.push(dateKey);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return expectedDates;
}

export async function getRecentExpectedWorkingDates(workspaceId, count = 3, referenceDate = new Date()) {
  const startDate = addDays(referenceDate, -14);
  const calendar = await getWorkspaceCalendar(workspaceId, startDate, referenceDate);
  const candidates = buildExpectedWorkingDates({
    startDate,
    endDate: referenceDate,
    workDayNums: calendar.workDayNums,
    holidayDates: calendar.holidayDates,
  });

  return candidates.slice(-count);
}

export async function getWorkspaceUserMap(workspaceId) {
  const users = await getWorkspaceUsers(workspaceId);
  return new Map(users.map((user) => [user.id, user]));
}
