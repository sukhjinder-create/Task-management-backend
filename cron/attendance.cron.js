import cron from "node-cron";
import { aggregateDailyAttendance } from "../services/attendanceAggregator.service.js";

export function startAttendanceCron() {
  // Runs daily at 00:10 AM
  cron.schedule("10 0 * * *", async () => {
    console.log("[cron] Running daily attendance aggregation...");
    await aggregateDailyAttendance();
  });
}
