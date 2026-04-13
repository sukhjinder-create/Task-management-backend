// cron/backup.cron.js
import cron from "node-cron";
import { runBackup } from "../backup/backup.service.js";

/**
 * 🗄️ BACKUP CRON JOB
 *
 * Runs a full database backup every day at 2:00 AM.
 * Controlled by the backup.service.js — handles pg_dump, optional S3 upload,
 * logging to backup_logs table, and pruning old local files.
 */
export function startBackupCron() {
  console.log("🗄️  Starting Backup cron job...");

  // Daily at 2:00 AM (fixed schedule for predictable backup load)
  cron.schedule("0 2 * * *", async () => {
    console.log("\n🗄️  [CRON] Running scheduled database backup...");
    try {
      const result = await runBackup("cron");
      if (result.success) {
        console.log(
          `✅ [CRON] Backup complete — ${result.fileName} ` +
          `(${(result.fileSizeBytes / 1024 / 1024).toFixed(2)} MB, ` +
          `${result.storageType}, ${result.duration}s)`
        );
      } else {
        console.error(`❌ [CRON] Backup failed: ${result.error}`);
      }
    } catch (err) {
      console.error("❌ [CRON] Backup cron threw:", err.message);
    }
  }, { timezone: "Asia/Kolkata" });

  console.log("✅ Backup cron job started");
  console.log("  - Schedule: Every day at 2:00 AM");
  console.log("  - Timezone: Asia/Kolkata");
}
