import cron from "node-cron";
import pool from "../db.js";
import { evaluateWorkspaceAutomations } from "../services/operationsAutomation.service.js";
import { deliverDueDigests } from "../services/operationsDigest.service.js";

async function getActiveWorkspaceIds() {
  const { rows } = await pool.query(
    `
    SELECT id
    FROM workspaces
    WHERE COALESCE(status, 'active') != 'suspended'
    `
  );

  return rows.map((row) => row.id);
}

export function startOperationsCron() {
  cron.schedule("15 */2 * * *", async () => {
    try {
      const workspaceIds = await getActiveWorkspaceIds();
      for (const workspaceId of workspaceIds) {
        try {
          await evaluateWorkspaceAutomations({ workspaceId, dryRun: false });
        } catch (error) {
          console.error("[operations-cron] automation run failed", {
            workspaceId,
            error: error.message,
          });
        }
      }
    } catch (error) {
      console.error("[operations-cron] workspace load failed", error.message);
    }
  });

  cron.schedule("5 * * * *", async () => {
    try {
      const result = await deliverDueDigests();
      if (result.delivered > 0) {
        console.log(`[operations-cron] delivered ${result.delivered} digest(s)`);
      }
    } catch (error) {
      console.error("[operations-cron] digest delivery failed", error.message);
    }
  });
}
