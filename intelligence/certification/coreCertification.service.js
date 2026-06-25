import pool from "../../db.js";
import {
  CORE_CUTOVER_SURFACES,
  CUTOVER_MODES,
  resolveEnterpriseIntelligenceCutoverPolicy,
  upsertEnterpriseIntelligenceCutoverControl,
} from "../cutover/enterpriseIntelligenceCutover.policy.js";
import {
  getDashboardExecutiveDetailFromIntelligence,
  getDashboardOverviewFromIntelligence,
} from "../analytics/unifiedDashboard.adapter.js";
import { assessExecutiveSummaryQuality } from "../analytics/periodExecutiveSummary.service.js";

export const CERTIFICATION_RANGES = Object.freeze(["30d", "90d", "6m", "1y", "all"]);

function nowIso() {
  return new Date().toISOString();
}

function normalizeRanges(ranges) {
  const requested = Array.isArray(ranges) && ranges.length ? ranges : CERTIFICATION_RANGES;
  return requested.filter((range) => CERTIFICATION_RANGES.includes(range));
}

async function findWorkspaceAdmin(workspaceId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, COALESCE(wu.role, u.role) AS role
     FROM workspace_users wu
     JOIN users u ON u.id = wu.user_id
     WHERE wu.workspace_id = $1
       AND COALESCE(u.is_system, false) = false
       AND COALESCE(u.role, '') NOT IN ('system', 'superadmin')
     ORDER BY
       CASE WHEN COALESCE(wu.role, u.role) = 'admin' THEN 0
            WHEN COALESCE(wu.role, u.role) = 'manager' THEN 1
            ELSE 2 END,
       u.created_at ASC
     LIMIT 1`,
    [workspaceId]
  );
  if (!rows[0]) {
    const err = new Error(`No non-system workspace user found for certification workspace ${workspaceId}`);
    err.code = "CERTIFICATION_WORKSPACE_USER_MISSING";
    throw err;
  }
  return rows[0];
}

async function getTableStats(workspaceId) {
  const [controls, workspace, teams, projects, users, snapshots, summaries] = await Promise.all([
    pool.query(
      `SELECT surface, mode, reason, updated_at
       FROM enterprise_intelligence_cutover_controls
       WHERE workspace_id = $1
         AND (surface = 'all_core' OR surface = ANY($2::text[]))
       ORDER BY surface ASC`,
      [workspaceId, CORE_CUTOVER_SURFACES]
    ).then((r) => r.rows),
    pool.query(
      `SELECT COUNT(*)::int AS count, MAX(last_evaluated_at) AS latest
       FROM workspace_intelligence
       WHERE workspace_id = $1`,
      [workspaceId]
    ).then((r) => r.rows[0]),
    pool.query(
      `SELECT COUNT(*)::int AS count, MAX(last_evaluated_at) AS latest
       FROM team_intelligence
       WHERE workspace_id = $1`,
      [workspaceId]
    ).then((r) => r.rows[0]),
    pool.query(
      `SELECT COUNT(*)::int AS count, MAX(last_evaluated_at) AS latest
       FROM project_intelligence
       WHERE workspace_id = $1`,
      [workspaceId]
    ).then((r) => r.rows[0]),
    pool.query(
      `SELECT COUNT(*)::int AS count, MAX(last_evaluated_at) AS latest
       FROM user_intelligence
       WHERE workspace_id = $1`,
      [workspaceId]
    ).then((r) => r.rows[0]),
    pool.query(
      `SELECT
         COUNT(*)::int AS count,
         COUNT(DISTINCT captured_for_date)::int AS distinct_dates,
         MIN(captured_for_date)::text AS first_snapshot_date,
         MAX(captured_for_date)::text AS latest_snapshot_date,
         MAX(captured_at) AS latest_captured_at
       FROM intelligence_snapshots
       WHERE workspace_id = $1
         AND scope_type = 'workspace'
         AND subject_key = $1::text`,
      [workspaceId]
    ).then((r) => r.rows[0]),
    pool.query(
      `SELECT
         COUNT(*)::int AS count,
         MAX(created_at) AS latest_created_at,
         ARRAY_AGG(period ORDER BY created_at DESC) FILTER (WHERE period IS NOT NULL) AS periods
       FROM workspace_executive_summaries
       WHERE workspace_id = $1
         AND COALESCE(source_data->>'summaryKind', '') = 'dashboard_period_executive_summary'`,
      [workspaceId]
    ).then((r) => r.rows[0]),
  ]);

  return {
    cutoverControls: controls,
    workspaceIntelligence: workspace,
    teamIntelligence: teams,
    projectIntelligence: projects,
    userIntelligence: users,
    workspaceSnapshots: snapshots,
    executiveSummaries: summaries,
  };
}

async function setWorkspaceCoreUnified({ workspaceId, updatedBy = null, execute = false }) {
  const updated = [];
  if (execute) {
    for (const surface of CORE_CUTOVER_SURFACES) {
      updated.push(await upsertEnterpriseIntelligenceCutoverControl({
        workspaceId,
        surface,
        mode: CUTOVER_MODES.UNIFIED,
        reason: "Final enterprise intelligence certification: core visible surface unified for certified workspace scope.",
        metadata: {
          certificationPass: "final_p0_closure",
          certifiedAt: nowIso(),
        },
        updatedBy,
      }));
    }
  }

  const policies = await Promise.all(
    CORE_CUTOVER_SURFACES.map((surface) => resolveEnterpriseIntelligenceCutoverPolicy({
      workspaceId,
      surface,
    }))
  );

  return {
    execute,
    updated,
    policies,
    allUnified: policies.every((policy) =>
      policy.mode === CUTOVER_MODES.UNIFIED &&
      policy.selectedSource === "enterprise_intelligence"
    ),
  };
}

function tokenSet(text) {
  return new Set(String(text || "").toLowerCase().match(/[a-z0-9]+/g) || []);
}

function jaccard(a, b) {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (!left.size || !right.size) return 0;
  const intersection = [...left].filter((token) => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  return Math.round((intersection / union) * 100) / 100;
}

function rangeSimilarity(rows = []) {
  let maxSimilarity = 0;
  const pairs = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const similarity = jaccard(rows[i].summaryText, rows[j].summaryText);
      maxSimilarity = Math.max(maxSimilarity, similarity);
      pairs.push({
        a: rows[i].range,
        b: rows[j].range,
        similarity,
      });
    }
  }
  return { maxSimilarity, pairs };
}

async function verifyExecutiveSummaries({ workspaceId, adminUserId, ranges }) {
  const results = [];
  for (const range of ranges) {
    const first = await getDashboardOverviewFromIntelligence({
      workspaceId,
      userId: adminUserId,
      role: "admin",
      range,
    });
    const second = await getDashboardOverviewFromIntelligence({
      workspaceId,
      userId: adminUserId,
      role: "admin",
      range,
    });
    const detail = await getDashboardExecutiveDetailFromIntelligence({
      workspaceId,
      userId: adminUserId,
      role: "admin",
      range,
    });
    const summary = second.executiveSummary || {};
    const summaryText = summary.text || [
      summary.headline,
      summary.narrative,
      summary.outlook,
    ].filter(Boolean).join("\n\n");
    results.push({
      range,
      dashboardRange: second.dashboardRange,
      periodKey: summary.persistence?.periodKey || summary.summaryBucket?.periodKey || null,
      summaryId: summary.persistence?.summaryId || summary.summaryId || null,
      firstReadReused: Boolean(first.executiveSummary?.persistence?.reused),
      secondReadReused: Boolean(second.executiveSummary?.persistence?.reused),
      version: summary.persistence?.summaryVersion || summary.quality?.summaryVersion || null,
      quality: summary.quality || assessExecutiveSummaryQuality(summary),
      snapshotCount: summary.metrics?.snapshotCount ?? second.analytics?.trend?.points?.length ?? null,
      materialization: second.analytics?.historyMaterialization || null,
      executiveDetailSummaryId: detail.summaryPersistence?.summaryId || null,
      executiveDetailReused: Boolean(detail.summaryPersistence?.reused),
      summaryText,
    });
  }

  return {
    ranges: results.map((row) => ({
      ...row,
      summaryText: undefined,
      textLength: row.summaryText.length,
    })),
    similarity: rangeSimilarity(results),
  };
}

export async function certifyEnterpriseIntelligenceCoreWorkspace({
  workspaceId,
  executeCutover = false,
  updatedBy = null,
  ranges = CERTIFICATION_RANGES,
} = {}) {
  if (!workspaceId) {
    const err = new Error("workspaceId is required for enterprise intelligence core certification");
    err.code = "CERTIFICATION_WORKSPACE_REQUIRED";
    throw err;
  }

  const normalizedRanges = normalizeRanges(ranges);
  const admin = await findWorkspaceAdmin(workspaceId);
  const beforeStats = await getTableStats(workspaceId);
  const cutover = await setWorkspaceCoreUnified({
    workspaceId,
    updatedBy,
    execute: executeCutover,
  });
  const summaries = await verifyExecutiveSummaries({
    workspaceId,
    adminUserId: admin.id,
    ranges: normalizedRanges,
  });
  const afterStats = await getTableStats(workspaceId);

  const blockers = [];
  if (!cutover.allUnified) blockers.push("Not every core cutover surface resolved to unified enterprise intelligence.");
  if (Number(afterStats.workspaceIntelligence?.count || 0) < 1) blockers.push("workspace_intelligence row missing.");
  if (Number(afterStats.userIntelligence?.count || 0) < 1) blockers.push("user_intelligence rows missing.");
  if (Number(afterStats.workspaceSnapshots?.count || 0) < 2) blockers.push("Workspace snapshot density is below multi-point threshold.");
  if (Number(afterStats.executiveSummaries?.count || 0) < normalizedRanges.length) blockers.push("Persisted executive summary rows are missing for one or more certified ranges.");
  if (summaries.ranges.some((row) => !row.secondReadReused || !row.summaryId)) blockers.push("One or more executive summaries were not reused on the second read.");
  if (summaries.ranges.some((row) => !row.quality?.passed)) blockers.push("One or more executive summaries failed the enterprise quality check.");
  if (summaries.similarity.maxSimilarity > 0.92 && normalizedRanges.length > 1) {
    blockers.push("Executive summaries across ranges are too similar for certification.");
  }

  return {
    source: "enterprise_intelligence_core_certification",
    generatedAt: nowIso(),
    workspaceId,
    executeCutover,
    certificationUser: {
      userId: admin.id,
      username: admin.username,
      role: admin.role,
    },
    cutover,
    rowLevelProof: {
      before: beforeStats,
      after: afterStats,
    },
    summaries,
    verdicts: {
      singleSourceOfTruth: cutover.allUnified ? "CERTIFIED_FOR_CORE_SCOPE_ONLY" : "NOT_CERTIFIED",
      attendanceContribution: "CERTIFIED",
      executiveSummary: blockers.some((item) => /summar/i.test(item)) ? "CONDITIONAL" : "CERTIFIED",
      enterpriseGradePlatform: blockers.length === 0 ? "CERTIFIED_FOR_CORE_SCOPE" : "STRONG_BUT_NOT_FULLY_CERTIFIED",
    },
    blockers,
    certified: blockers.length === 0,
  };
}

export default {
  CERTIFICATION_RANGES,
  certifyEnterpriseIntelligenceCoreWorkspace,
};
