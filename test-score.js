import { calculateScore } from "./events/scoring/scoreCalculator.js";

const testCases = [
  {
    name: "Balanced attendance with reasonable breaks",
    input: {
      hasAttendanceTracking: true,
      attendanceTelemetryStatus: "tracked",
      attendancePresenceRatio: 0.95,
      attendanceHourQualityRatio: 0.9,
      attendanceAvailabilityRatio: 0.82,
      attendanceAwsDisciplineRatio: 0.88,
      attendanceLunchDisciplineRatio: 0.92,
      attendanceConsistencyRatio: 0.9,
      taskCompletionRatio: 0.9,
      timelinessRatio: 0.85,
      storyPointVelocityRatio: 0.8,
      estimationAccuracyRatio: 0.8,
      collaborationRatio: 0.7,
      blockerResolutionRatio: 0.9,
    },
  },
  {
    name: "Frequent AWS and long lunch usage",
    input: {
      hasAttendanceTracking: true,
      attendanceTelemetryStatus: "tracked",
      attendancePresenceRatio: 0.9,
      attendanceHourQualityRatio: 0.8,
      attendanceAvailabilityRatio: 0.55,
      attendanceAwsDisciplineRatio: 0.25,
      attendanceLunchDisciplineRatio: 0.35,
      attendanceConsistencyRatio: 0.7,
      taskCompletionRatio: 0.65,
      timelinessRatio: 0.6,
      storyPointVelocityRatio: 0.55,
      estimationAccuracyRatio: 0.6,
      collaborationRatio: 0.5,
      blockerResolutionRatio: 0.7,
    },
  },
  {
    name: "No attendance telemetry available",
    input: {
      hasAttendanceTracking: false,
      attendanceTelemetryStatus: "missing",
      taskCompletionRatio: 0.6,
      timelinessRatio: 0.6,
      storyPointVelocityRatio: 0.6,
      estimationAccuracyRatio: 0.5,
      collaborationRatio: 0.5,
      blockerResolutionRatio: 0.8,
    },
  },
  {
    name: "Workspace tracks attendance but user was absent",
    input: {
      hasAttendanceTracking: true,
      attendanceTelemetryStatus: "absent",
      attendancePresenceRatio: 0,
      attendanceHourQualityRatio: 0,
      attendanceAvailabilityRatio: 0,
      attendanceAwsDisciplineRatio: 0,
      attendanceLunchDisciplineRatio: 0,
      attendanceConsistencyRatio: 0,
      taskCompletionRatio: 0.5,
      timelinessRatio: 0.5,
      storyPointVelocityRatio: 0.5,
      estimationAccuracyRatio: 0.5,
      collaborationRatio: 0.5,
      blockerResolutionRatio: 0.5,
    },
  },
];

for (const testCase of testCases) {
  const result = calculateScore(testCase.input);
  console.log(`\n--- ${testCase.name} ---`);
  console.log(result);
}
