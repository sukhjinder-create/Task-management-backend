import { aggregateDailyAttendance } from "./attendanceAggregator.service.js";

function toDateKey(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function getDateRange({ from, to }) {
  const today = new Date();
  const end = to ? new Date(`${to}T00:00:00.000Z`) : today;
  const start = from ? new Date(`${from}T00:00:00.000Z`) : end;

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error("Invalid date range supplied for attendance recalculation");
  }
  if (start > end) {
    throw new Error("'from' must be before or equal to 'to'");
  }

  return { start, end };
}

/**
 * Recalculate daily attendance from raw attendance events using the same
 * state-machine aggregator as the scheduled job.
 */
export async function recalculateDailyAttendance({
  workspaceId,
  userId = null,
  from = null,
  to = null,
}) {
  if (!workspaceId) {
    throw new Error("workspaceId is required for recalculation");
  }

  const { start, end } = getDateRange({ from, to });

  let daysProcessed = 0;
  const processedDates = [];
  const cursor = new Date(start);

  while (cursor <= end) {
    const dateKey = toDateKey(cursor);
    await aggregateDailyAttendance(dateKey, { workspaceId, userId });
    processedDates.push(dateKey);
    daysProcessed += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return {
    daysProcessed,
    usersProcessed: userId ? 1 : null,
    from: processedDates[0] || null,
    to: processedDates[processedDates.length - 1] || null,
  };
}
