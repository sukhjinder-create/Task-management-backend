import cron from "node-cron";
import pool from "../db.js";
import { getUnifiedIntelligenceSnapshot } from "../intelligence/engine/unifiedIntelligence.engine.js";
import {
  recordRecalculationEvent,
  writeSnapshot,
} from "../intelligence/repositories/unifiedIntelligence.repository.js";

async function writeAuthoritativeSnapshots({ workspaceId, snapshot, periodKeys }) {
  let written = 0;

  for (const periodKey of periodKeys) {
    if (snapshot.workspace) {
      await writeSnapshot({
        scopeType: "workspace",
        subjectKey: String(workspaceId),
        result: { ...snapshot.workspace, workspaceId },
        periodKey,
      });
      written += 1;
    }

    for (const user of snapshot.users || []) {
      await writeSnapshot({
        scopeType: "user",
        subjectKey: String(user.userId),
        result: { ...user, workspaceId },
        periodKey,
      });
      written += 1;
    }

    for (const project of snapshot.projects || []) {
      await writeSnapshot({
        scopeType: "project",
        subjectKey: String(project.projectId),
        result: { ...project, workspaceId },
        periodKey,
      });
      written += 1;
    }

    for (const team of snapshot.teams || []) {
      await writeSnapshot({
        scopeType: "team",
        subjectKey: String(team.teamKey),
        result: { ...team, workspaceId },
        periodKey,
      });
      written += 1;
    }
  }

  return written;
}

/**
 * Cron-side intelligence is snapshot/audit only.
 *
 * Real-time recalculation owns live scores. This scheduled job captures the
 * current authoritative repository rows into intelligence_snapshots so
 * historical dashboards can read without recalculating.
 */
export async function runMonthlyIntelligence({
  month,
  previousMonth,
  mode = "scheduled_snapshot",
}) {
  console.log("[intelligence-cron] Authoritative snapshot run started:", month);

  const { rows: workspaces } = await pool.query(
    `SELECT id FROM workspaces WHERE is_active = true`
  );

  for (const ws of workspaces) {
    const workspaceId = ws.id;
    console.log("[intelligence-cron] Workspace snapshot:", workspaceId);

    try {
      const snapshot = await getUnifiedIntelligenceSnapshot({
        workspaceId,
        role: "admin",
      });
      const periodKeys = mode === "month_close_snapshot"
        ? ["rolling_30d", `month:${month}`]
        : ["rolling_30d"];
      const snapshotsWritten = await writeAuthoritativeSnapshots({
        workspaceId,
        snapshot,
        periodKeys,
      });

      await recordRecalculationEvent({
        workspaceId,
        reason: "scheduled_intelligence_snapshot",
        sourceType: "cron",
        sourceId: month,
        metadata: {
          mode,
          month,
          previousMonth,
          periodKeys,
          snapshotsWritten,
          scoreSource: "enterprise_intelligence_repositories",
          legacyMonthlyScoringSkipped: true,
        },
      });
    } catch (err) {
      if (err?.code === "INTELLIGENCE_SCHEMA_MISSING") {
        console.warn(
          "[intelligence-cron] Enterprise intelligence schema missing; snapshot skipped for",
          workspaceId
        );
        continue;
      }
      throw err;
    }
  }

  console.log("[intelligence-cron] Authoritative snapshot run completed:", month);
}

export function startMonthlyIntelligenceCron() {
  const monthStr = (offsetMonths = 0) => {
    const d = new Date();
    d.setMonth(d.getMonth() + offsetMonths);
    return d.toISOString().slice(0, 7);
  };

  cron.schedule("0 2 1 * *", async () => {
    const month = monthStr(-1);
    const previousMonth = monthStr(-2);
    console.log(`[intelligence-cron] End-of-month snapshot for ${month}`);
    try {
      await runMonthlyIntelligence({
        month,
        previousMonth,
        mode: "month_close_snapshot",
      });
    } catch (err) {
      console.error("[intelligence-cron] End-of-month snapshot failed:", err);
    }
  });

  cron.schedule("0 3 * * 0", async () => {
    const month = monthStr(0);
    const previousMonth = monthStr(-1);
    console.log(`[intelligence-cron] Weekly snapshot for ${month}`);
    try {
      await runMonthlyIntelligence({
        month,
        previousMonth,
        mode: "weekly_snapshot",
      });
    } catch (err) {
      console.error("[intelligence-cron] Weekly snapshot failed:", err);
    }
  });

  console.log("[intelligence-cron] Snapshot cron started (month-close audit + weekly history)");
}
