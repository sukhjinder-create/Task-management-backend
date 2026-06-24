import {
  adaptiveScore,
  bounded,
  clamp,
  domainSummary,
  evidenceConfidence,
  ratio,
  trendFromSeries,
  uniqueStrings,
  varianceScore,
} from "../engine/scorePrimitives.js";

const EXPECTED_DAY_MINUTES = 480;
const TARGET_AVAILABLE_RATIO = 0.72;
const MEANINGFUL_TIME_LOG_HOURS = 2;
const MAX_EXCEPTIONAL_ATTENDANCE_INDICATORS = 3;

function minutesOfDay(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.getHours() * 60 + d.getMinutes();
}

function byDateEvents(events = []) {
  const map = new Map();
  for (const event of events) {
    const key = String(event.started_at || "").slice(0, 10);
    if (!key) continue;
    const list = map.get(key) || [];
    list.push(event);
    map.set(key, list);
  }
  return map;
}

function sum(rows, field) {
  return rows.reduce((total, row) => total + (Number(row[field]) || 0), 0);
}

function splitHalf(values = []) {
  const midpoint = Math.ceil(values.length / 2);
  return [values.slice(0, midpoint), values.slice(midpoint)];
}

function avg(nums = []) {
  const values = nums.map(Number).filter(Number.isFinite);
  if (!values.length) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function evaluateAttendance(evidence) {
  const {
    calendar,
    attendance,
    attendanceByDate,
    attendanceEvents,
    deliveryByDate,
  } = evidence;

  const expectedDays = calendar.expectedWorkingDays || [];
  const expectedCapacity = expectedDays.reduce((total, day) => total + day.expectedCapacity, 0);
  const workingAttendanceRows = expectedDays
    .map((day) => ({ day, row: attendanceByDate.get(day.date) }))
    .filter((entry) => entry.row);

  const presentCapacity = expectedDays.reduce((total, day) => {
    const row = attendanceByDate.get(day.date);
    if (!row || Number(row.signed_in_minutes) <= 0) return total;
    return total + day.expectedCapacity;
  }, 0);

  const unexplainedAbsences = expectedDays.filter((day) => {
    const row = attendanceByDate.get(day.date);
    return day.expectedCapacity > 0 && (!row || Number(row.signed_in_minutes) <= 0);
  });

  const eventsByDate = byDateEvents(attendanceEvents);
  const signIns = [];
  const signOffs = [];
  for (const day of expectedDays) {
    const events = eventsByDate.get(day.date) || [];
    const inEvent = events.find((event) => event.event_type === "SIGN_IN");
    const offEvent = [...events].reverse().find((event) => event.event_type === "SIGN_OFF");
    const inMin = minutesOfDay(inEvent?.started_at);
    const offMin = minutesOfDay(offEvent?.started_at);
    if (inMin != null) signIns.push(inMin);
    if (offMin != null) signOffs.push(offMin);
  }

  const signedInMinutes = sum(workingAttendanceRows.map((entry) => entry.row), "signed_in_minutes");
  const availableMinutes = sum(workingAttendanceRows.map((entry) => entry.row), "available_minutes");
  const awsMinutes = sum(workingAttendanceRows.map((entry) => entry.row), "aws_minutes");
  const lunchMinutes = sum(workingAttendanceRows.map((entry) => entry.row), "lunch_minutes");
  const screenOn = sum(workingAttendanceRows.map((entry) => entry.row), "screen_on_minutes");
  const screenOff = sum(workingAttendanceRows.map((entry) => entry.row), "screen_off_minutes");

  const presentDays = workingAttendanceRows.filter((entry) => Number(entry.row.signed_in_minutes) > 0).length;
  const expectedMinutes = expectedCapacity * EXPECTED_DAY_MINUTES;
  const presenceReliability = adaptiveScore([
    { value: ratio(presentCapacity, expectedCapacity, 0.65) * 100 },
    { value: bounded(unexplainedAbsences.length, 0, Math.max(2, expectedDays.length * 0.35)) * 100 },
  ], {
    confidence: evidenceConfidence({
      observed: presentDays,
      expected: Math.max(1, expectedDays.length),
      breadth: expectedDays.length >= 8 ? 1 : 0.7,
    }),
  });

  const scheduleDiscipline = adaptiveScore([
    { value: varianceScore(signIns, 45) },
    { value: varianceScore(signOffs, 60) },
    { value: signIns.length > 0 ? bounded(Math.max(0, signIns.length - expectedDays.length), 0, 2) * 100 : 65 },
  ], {
    confidence: evidenceConfidence({
      observed: signIns.length,
      expected: Math.max(1, presentDays),
      breadth: signIns.length > 2 ? 1 : 0.5,
    }),
  });

  const availabilityRatio = signedInMinutes > 0 ? availableMinutes / signedInMinutes : 0;
  const focusRatio = (screenOn + screenOff) > 0 ? screenOn / (screenOn + screenOff) : null;
  const availabilityQuality = adaptiveScore([
    { value: bounded(availabilityRatio, TARGET_AVAILABLE_RATIO, 0.35) * 100 },
    { value: bounded(signedInMinutes, expectedMinutes * 0.75, expectedMinutes * 0.35) * 100 },
    { value: focusRatio == null ? 65 : bounded(focusRatio, 0.70, 0.35) * 100 },
  ], {
    confidence: evidenceConfidence({
      observed: signedInMinutes > 0 ? presentDays : 0,
      expected: Math.max(1, expectedDays.length),
      breadth: focusRatio == null ? 0.65 : 1,
    }),
  });

  const breakMinutesPerPresentDay = presentDays > 0 ? (awsMinutes + lunchMinutes) / presentDays : 0;
  const breakDiscipline = adaptiveScore([
    { value: bounded(breakMinutesPerPresentDay, 75, 180) * 100 },
    { value: bounded(awsMinutes / Math.max(1, presentDays), 45, 150) * 100 },
    { value: bounded(lunchMinutes / Math.max(1, presentDays), 60, 130) * 100 },
  ], {
    confidence: evidenceConfidence({
      observed: presentDays,
      expected: Math.max(1, expectedDays.length),
      breadth: 0.85,
    }),
  });

  const signedInByDay = expectedDays.map((day) => {
    const row = attendanceByDate.get(day.date);
    return Number(row?.signed_in_minutes) || 0;
  });
  const [firstHalf, secondHalf] = splitHalf(signedInByDay);
  const attendanceStability = adaptiveScore([
    { value: varianceScore(signedInByDay, 90) },
    { value: bounded(Math.abs(avg(secondHalf) - avg(firstHalf)), 30, 180) * 100 },
    { value: ratio(presentCapacity, expectedCapacity, 0.65) * 100 },
  ], {
    confidence: evidenceConfidence({
      observed: signedInByDay.filter((value) => value > 0).length,
      expected: Math.max(1, expectedDays.length),
      breadth: expectedDays.length >= 10 ? 1 : 0.7,
      volatility: Math.min(1, Math.abs(avg(secondHalf) - avg(firstHalf)) / 240),
    }),
  });

  const nonWorkingAttendance = (calendar.nonWorkingDays || [])
    .map((day) => ({ day, row: attendanceByDate.get(day.date), delivery: deliveryByDate.get(day.date) }))
    .filter((entry) => entry.row && Number(entry.row.signed_in_minutes) > 0);

  const exceptionalIndicators = [];
  let trivialNonWorkingActivity = 0;
  const burnoutSignals = [];
  for (const entry of nonWorkingAttendance) {
    const meaningfulDelivery = {
      completedTasks: Number(entry.delivery?.completedTasks || 0),
      storyPoints: Number(entry.delivery?.storyPoints || 0),
      blockerResolutions: Number(entry.delivery?.blockerResolutions || 0),
      timeLogHours: Number(entry.delivery?.timeLogHours || 0),
    };
    const delivered = meaningfulDelivery.completedTasks > 0
      || meaningfulDelivery.storyPoints > 0
      || meaningfulDelivery.blockerResolutions > 0
      || meaningfulDelivery.timeLogHours >= MEANINGFUL_TIME_LOG_HOURS;
    if (delivered) {
      if (exceptionalIndicators.length < MAX_EXCEPTIONAL_ATTENDANCE_INDICATORS) {
        exceptionalIndicators.push({
          type: entry.day.holiday ? "Holiday Contribution" : "Weekend Contribution",
          date: entry.day.date,
          label: entry.day.holiday
            ? "Meaningful delivery on a holiday"
            : "Meaningful delivery on a non-working day",
          evidence: meaningfulDelivery,
        });
      }
    } else {
      trivialNonWorkingActivity += 1;
    }
  }

  const longDays = attendance.filter((row) => Number(row.signed_in_minutes) > 600).length;
  if (nonWorkingAttendance.length >= 3) {
    burnoutSignals.push("Repeated non-working day attendance detected");
  }
  if (longDays >= 5) {
    burnoutSignals.push("Sustained long work hours detected");
  }
  if (avg(secondHalf) > avg(firstHalf) + 90 && availabilityQuality < 58) {
    burnoutSignals.push("Longer hours are not translating into stronger availability");
  }

  const trend = trendFromSeries(signedInByDay);
  const confidence = evidenceConfidence({
    observed: attendance.length,
    expected: Math.max(1, expectedDays.length),
    breadth: attendanceEvents.length > 0 ? 1 : 0.72,
    volatility: Math.min(1, Math.abs(avg(secondHalf) - avg(firstHalf)) / 360),
  });

  const strengths = [];
  const concerns = [];
  const drivers = [];

  if (presenceReliability >= 76) strengths.push("Consistent attendance on expected working days");
  if (availabilityQuality >= 76) strengths.push("Reliable available time during signed-in windows");
  if (breakDiscipline >= 76) strengths.push("Break and away-time patterns stayed controlled");
  if (attendanceStability >= 76) strengths.push("Attendance pattern is stable across the evaluation window");

  if (presenceReliability < 58) concerns.push("Unexplained absences reduced workplace participation reliability");
  if (scheduleDiscipline < 58) concerns.push("Sign-in or sign-off timing is inconsistent");
  if (availabilityQuality < 58) concerns.push("Available work time is below expected readiness");
  if (breakDiscipline < 58) concerns.push("Break or away-time patterns are becoming excessive");
  concerns.push(...burnoutSignals);

  drivers.push(
    `Evaluated ${expectedDays.length} valid working day(s) after excluding holidays and approved leave`,
    `Observed ${presentDays} day(s) with attendance telemetry`,
  );
  if (exceptionalIndicators.length > 0) {
    drivers.push(`${exceptionalIndicators.length} exceptional contribution signal(s) recognized without inflating score`);
  }
  if (trivialNonWorkingActivity > 0) {
    drivers.push(`${trivialNonWorkingActivity} non-working day attendance signal(s) treated as informational because delivery evidence was not meaningful`);
  }

  const dimensions = {
    presenceReliability,
    scheduleDiscipline,
    availabilityQuality,
    breakDiscipline,
    attendanceStability,
  };

  const score = adaptiveScore(
    Object.values(dimensions).map((value) => ({ value })),
    { confidence }
  );

  return domainSummary({
    name: "Attendance Intelligence",
    score,
    confidence,
    strengths: uniqueStrings(strengths),
    concerns: uniqueStrings(concerns),
    drivers: uniqueStrings(drivers),
    metrics: {
      reliability: presenceReliability >= 75 ? "High" : presenceReliability >= 55 ? "Moderate" : "Low",
      scheduleDiscipline: scheduleDiscipline >= 75 ? "High" : scheduleDiscipline >= 55 ? "Moderate" : "Low",
      availabilityQuality: availabilityQuality >= 75 ? "High" : availabilityQuality >= 55 ? "Moderate" : "Low",
      breakDiscipline: breakDiscipline >= 75 ? "High" : breakDiscipline >= 55 ? "Moderate" : "Low",
      trend,
      expectedWorkingDays: expectedDays.length,
      presentDays,
      excludedHolidays: calendar.holidayCount || 0,
      approvedLeaveDays: Math.round((calendar.approvedLeaveDays || 0) * 10) / 10,
      attendanceClosedThroughDate: evidence.attendanceClosedThroughDate || null,
      coverageStart: evidence.attendanceCoverage?.startDate || null,
      coverageEnd: evidence.attendanceCoverage?.endDate || null,
      confidence,
      meaningfulDeliveryRule: {
        completedTasks: "at least one completed task",
        storyPoints: "any completed story-point delivery",
        blockerResolutions: "at least one blocker resolved",
        timeLogHours: `at least ${MEANINGFUL_TIME_LOG_HOURS} logged hour(s) on delivery work`,
        indicatorLimit: MAX_EXCEPTIONAL_ATTENDANCE_INDICATORS,
        scoreInflation: "exceptional contribution indicators are recognition signals only, not direct score multipliers",
      },
    },
    indicators: exceptionalIndicators,
  });
}

export default evaluateAttendance;
