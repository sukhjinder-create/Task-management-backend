import pool from "../../db.js";

const DEFAULT_WORK_DAYS = [1, 2, 3, 4, 5];

function toDateKey(value) {
  if (!value) return null;
  return String(value).slice(0, 10);
}

function utcDate(dateKey) {
  return new Date(`${dateKey}T00:00:00.000Z`);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function getRangeFromWindow(windowDays = 30, now = new Date()) {
  const end = new Date(now);
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - Math.max(1, Number(windowDays) || 30) + 1);
  start.setUTCHours(0, 0, 0, 0);
  end.setUTCHours(23, 59, 59, 999);
  return {
    start,
    end,
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
    windowDays: Math.max(1, Number(windowDays) || 30),
  };
}

function buildDateKeys(startDate, endDate) {
  const keys = [];
  let cursor = utcDate(startDate);
  const end = utcDate(endDate);
  while (cursor <= end) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor = addDays(cursor, 1);
  }
  return keys;
}

function applyLeaveCapacity(map, leaveRows, workDayNums, holidayDates) {
  for (const row of leaveRows) {
    const startKey = toDateKey(row.start_date || row.start);
    const endKey = toDateKey(row.end_date || row.end);
    if (!startKey || !endKey) continue;

    const workingKeys = buildDateKeys(startKey, endKey).filter((dateKey) => {
      const dow = utcDate(dateKey).getUTCDay();
      return workDayNums.includes(dow) && !holidayDates.has(dateKey);
    });
    if (!workingKeys.length) continue;

    let remaining = Number(row.days);
    if (!Number.isFinite(remaining) || remaining <= 0) remaining = workingKeys.length;

    for (const dateKey of workingKeys) {
      if (remaining <= 0) break;
      const leaveCapacity = Math.min(1, remaining);
      map.set(dateKey, Math.min(1, (map.get(dateKey) || 0) + leaveCapacity));
      remaining -= leaveCapacity;
    }
  }
}

export async function getWorkspaceCalendar({ workspaceId, userId = null, startDate, endDate }) {
  const [{ rows: scheduleRows }, { rows: holidayRows }, { rows: leaveRows }] = await Promise.all([
    pool.query(
      `SELECT work_days FROM workspace_work_schedule WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId]
    ).catch(() => ({ rows: [] })),
    pool.query(
      `SELECT date::text AS date, name
       FROM workspace_holidays
       WHERE workspace_id = $1
         AND date BETWEEN $2 AND $3`,
      [workspaceId, startDate, endDate]
    ).catch(() => ({ rows: [] })),
    userId
      ? pool.query(
        `SELECT start_date::text, end_date::text, days
         FROM leave_requests
         WHERE workspace_id = $1
           AND user_id = $2
           AND status = 'approved'
           AND end_date >= $3
           AND start_date <= $4`,
        [workspaceId, userId, startDate, endDate]
      ).catch(() => ({ rows: [] }))
      : Promise.resolve({ rows: [] }),
  ]);

  const workDayNums = (scheduleRows[0]?.work_days || DEFAULT_WORK_DAYS).map(Number);
  const holidayDates = new Set(holidayRows.map((row) => toDateKey(row.date)));
  const leaveCapacityByDate = new Map();
  applyLeaveCapacity(leaveCapacityByDate, leaveRows, workDayNums, holidayDates);

  const dateKeys = buildDateKeys(startDate, endDate);
  const dayContexts = dateKeys.map((dateKey) => {
    const dow = utcDate(dateKey).getUTCDay();
    const scheduledWorkday = workDayNums.includes(dow);
    const holiday = holidayDates.has(dateKey);
    const leaveCapacity = leaveCapacityByDate.get(dateKey) || 0;
    const expectedCapacity = scheduledWorkday && !holiday
      ? Math.max(0, 1 - leaveCapacity)
      : 0;
    return {
      date: dateKey,
      dow,
      scheduledWorkday,
      holiday,
      approvedLeaveCapacity: leaveCapacity,
      expectedCapacity,
      nonWorking: expectedCapacity <= 0,
    };
  });

  return {
    workDayNums,
    holidayDates,
    leaveCapacityByDate,
    dayContexts,
    expectedWorkingDays: dayContexts.filter((day) => day.expectedCapacity > 0),
    nonWorkingDays: dayContexts.filter((day) => day.nonWorking),
    holidayCount: holidayDates.size,
    approvedLeaveDays: [...leaveCapacityByDate.values()].reduce((sum, v) => sum + v, 0),
  };
}
