import cron from "node-cron";
import { aggregateDailyAttendance } from "../services/attendanceAggregator.service.js";
import { runAttendanceIntelligenceCloseout } from "../intelligence/realtime/attendanceCloseout.service.js";

export function startAttendanceCron() {
  // Runs daily after day closeout. Attendance intelligence is recalculated here,
  // not on every sign-in/sign-off event, so absence and discipline signals are complete.
  cron.schedule("10 0 * * *", async () => {
    console.log("[cron] Running daily attendance aggregation...");
    const aggregation = await aggregateDailyAttendance();
    if (!aggregation?.ok) {
      console.warn("[cron] Skipping attendance intelligence closeout because aggregation failed.");
      return;
    }

    console.log("[cron] Running end-of-day attendance intelligence closeout...");
    const closeout = await runAttendanceIntelligenceCloseout({ date: aggregation.date });
    console.log("[cron] Attendance intelligence closeout complete", {
      date: closeout.date,
      workspaces: closeout.workspaces,
    });
  });
}
