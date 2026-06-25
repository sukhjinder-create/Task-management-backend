import pool from "../../db.js";
import { INTELLIGENCE_VERSION, compactJson } from "../engine/scorePrimitives.js";

function json(value, fallback) {
  return JSON.stringify(compactJson(value ?? fallback));
}

function sourceWindow(row) {
  return row?.source_window || row?.payload?.sourceWindow || {};
}

function attendanceClosedThrough(row) {
  const window = sourceWindow(row);
  return (
    window.attendanceClosedThroughDate ||
    row?.attendance?.sourceWindow?.attendanceClosedThroughDate ||
    row?.attendance?.metrics?.attendanceClosedThroughDate ||
    null
  );
}

function liveTimeModel(row) {
  const window = sourceWindow(row);
  return {
    intelligenceMode: "live_operational",
    computedAt: row?.last_evaluated_at || row?.updated_at || null,
    coverageStart: window.startDate || window.coverageStart || null,
    coverageEnd: window.endDate || window.coverageEnd || null,
    attendanceClosedThroughDate: attendanceClosedThrough(row),
    snapshotDate: null,
  };
}

function snapshotTimeModel(row) {
  const window = sourceWindow(row);
  return {
    intelligenceMode: "historical_snapshot",
    computedAt: row?.captured_at || null,
    coverageStart: window.startDate || window.coverageStart || null,
    coverageEnd: window.endDate || window.coverageEnd || null,
    attendanceClosedThroughDate: attendanceClosedThrough(row),
    snapshotDate: row?.captured_for_date || null,
  };
}

async function hasTable(tableName) {
  const { rows } = await pool.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = $1
     ) AS exists`,
    [tableName]
  );
  return Boolean(rows[0]?.exists);
}

export async function hasEnterpriseIntelligenceSchema() {
  const tables = [
    "user_intelligence",
    "project_intelligence",
    "team_intelligence",
    "workspace_intelligence",
    "intelligence_snapshots",
  ];
  const results = await Promise.all(tables.map(hasTable));
  return results.every(Boolean);
}

function mapUserRow(row) {
  if (!row) return null;
  const time = liveTimeModel(row);
  const scoreModel = row.analytics?.scoreModel || row.payload?.scoreModel || null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    username: row.username,
    score: Number(row.score) || 0,
    band: row.band,
    trend: row.trend,
    confidence: Number(row.confidence) || 0,
    dimensions: row.dimensions || {},
    attendance: row.attendance || {},
    strengths: row.strengths || [],
    concerns: row.concerns || [],
    drivers: row.drivers || [],
    indicators: row.indicators || [],
    risk: row.risk || {},
    analytics: row.analytics || {},
    scoreModel,
    sourceWindow: row.source_window || {},
    evidenceHash: row.evidence_hash,
    calculationVersion: row.calculation_version,
    lastEvaluatedAt: row.last_evaluated_at,
    computedAt: time.computedAt,
    coverageStart: time.coverageStart,
    coverageEnd: time.coverageEnd,
    attendanceClosedThroughDate: time.attendanceClosedThroughDate,
    snapshotDate: time.snapshotDate,
    intelligenceMode: time.intelligenceMode,
    time,
  };
}

function mapProjectRow(row) {
  if (!row) return null;
  const time = liveTimeModel(row);
  const scoreModel = row.analytics?.scoreModel || row.payload?.scoreModel || null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    projectName: row.project_name,
    score: Number(row.score) || 0,
    band: row.band,
    trend: row.trend,
    confidence: Number(row.confidence) || 0,
    indexes: row.indexes || {},
    strengths: row.strengths || [],
    concerns: row.concerns || [],
    drivers: row.drivers || [],
    indicators: row.indicators || [],
    risk: row.risk || {},
    analytics: row.analytics || {},
    scoreModel,
    sourceWindow: row.source_window || {},
    evidenceHash: row.evidence_hash,
    calculationVersion: row.calculation_version,
    lastEvaluatedAt: row.last_evaluated_at,
    computedAt: time.computedAt,
    coverageStart: time.coverageStart,
    coverageEnd: time.coverageEnd,
    attendanceClosedThroughDate: time.attendanceClosedThroughDate,
    snapshotDate: time.snapshotDate,
    intelligenceMode: time.intelligenceMode,
    time,
  };
}

function mapTeamRow(row) {
  if (!row) return null;
  const time = liveTimeModel(row);
  const scoreModel = row.analytics?.scoreModel || row.payload?.scoreModel || null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    teamKey: row.team_key,
    managerId: row.manager_id,
    managerName: row.manager_name,
    score: Number(row.score) || 0,
    band: row.band,
    trend: row.trend,
    confidence: Number(row.confidence) || 0,
    indexes: row.indexes || {},
    strengths: row.strengths || [],
    concerns: row.concerns || [],
    drivers: row.drivers || [],
    indicators: row.indicators || [],
    risk: row.risk || {},
    analytics: row.analytics || {},
    scoreModel,
    sourceWindow: row.source_window || {},
    evidenceHash: row.evidence_hash,
    calculationVersion: row.calculation_version,
    lastEvaluatedAt: row.last_evaluated_at,
    computedAt: time.computedAt,
    coverageStart: time.coverageStart,
    coverageEnd: time.coverageEnd,
    attendanceClosedThroughDate: time.attendanceClosedThroughDate,
    snapshotDate: time.snapshotDate,
    intelligenceMode: time.intelligenceMode,
    time,
  };
}

function mapWorkspaceRow(row) {
  if (!row) return null;
  const time = liveTimeModel(row);
  const scoreModel = row.analytics?.scoreModel || row.payload?.scoreModel || null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    score: Number(row.score) || 0,
    band: row.band,
    trend: row.trend,
    confidence: Number(row.confidence) || 0,
    indexes: row.indexes || {},
    strengths: row.strengths || [],
    concerns: row.concerns || [],
    drivers: row.drivers || [],
    indicators: row.indicators || [],
    risk: row.risk || {},
    analytics: row.analytics || {},
    scoreModel,
    sourceWindow: row.source_window || {},
    evidenceHash: row.evidence_hash,
    calculationVersion: row.calculation_version,
    lastEvaluatedAt: row.last_evaluated_at,
    computedAt: time.computedAt,
    coverageStart: time.coverageStart,
    coverageEnd: time.coverageEnd,
    attendanceClosedThroughDate: time.attendanceClosedThroughDate,
    snapshotDate: time.snapshotDate,
    intelligenceMode: time.intelligenceMode,
    time,
  };
}

export async function saveUserIntelligence(result) {
  const { rows } = await pool.query(
    `INSERT INTO user_intelligence
      (workspace_id, user_id, score, band, trend, confidence, dimensions, attendance,
       strengths, concerns, drivers, indicators, risk, analytics, source_window,
       evidence_hash, calculation_version, last_evaluated_at)
     VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now())
     ON CONFLICT (workspace_id, user_id)
     DO UPDATE SET
       score = EXCLUDED.score,
       band = EXCLUDED.band,
       trend = EXCLUDED.trend,
       confidence = EXCLUDED.confidence,
       dimensions = EXCLUDED.dimensions,
       attendance = EXCLUDED.attendance,
       strengths = EXCLUDED.strengths,
       concerns = EXCLUDED.concerns,
       drivers = EXCLUDED.drivers,
       indicators = EXCLUDED.indicators,
       risk = EXCLUDED.risk,
       analytics = EXCLUDED.analytics,
       source_window = EXCLUDED.source_window,
       evidence_hash = EXCLUDED.evidence_hash,
       calculation_version = EXCLUDED.calculation_version,
       last_evaluated_at = now(),
       updated_at = now()
     RETURNING *`,
    [
      result.workspaceId,
      result.userId,
      result.score,
      result.band,
      result.trend,
      result.confidence,
      json(result.dimensions, {}),
      json(result.attendance, {}),
      json(result.strengths, []),
      json(result.concerns, []),
      json(result.drivers, []),
      json(result.indicators, []),
      json(result.risk, {}),
      json(result.analytics, {}),
      json(result.sourceWindow, {}),
      result.evidenceHash,
      result.calculationVersion || INTELLIGENCE_VERSION,
    ]
  );
  return mapUserRow(rows[0]);
}

export async function saveProjectIntelligence(result) {
  const { rows } = await pool.query(
    `INSERT INTO project_intelligence
      (workspace_id, project_id, score, band, trend, confidence, indexes,
       strengths, concerns, drivers, indicators, risk, analytics, source_window,
       evidence_hash, calculation_version, last_evaluated_at)
     VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
     ON CONFLICT (workspace_id, project_id)
     DO UPDATE SET
       score = EXCLUDED.score,
       band = EXCLUDED.band,
       trend = EXCLUDED.trend,
       confidence = EXCLUDED.confidence,
       indexes = EXCLUDED.indexes,
       strengths = EXCLUDED.strengths,
       concerns = EXCLUDED.concerns,
       drivers = EXCLUDED.drivers,
       indicators = EXCLUDED.indicators,
       risk = EXCLUDED.risk,
       analytics = EXCLUDED.analytics,
       source_window = EXCLUDED.source_window,
       evidence_hash = EXCLUDED.evidence_hash,
       calculation_version = EXCLUDED.calculation_version,
       last_evaluated_at = now(),
       updated_at = now()
     RETURNING *`,
    [
      result.workspaceId,
      result.projectId,
      result.score,
      result.band,
      result.trend,
      result.confidence,
      json(result.indexes, {}),
      json(result.strengths, []),
      json(result.concerns, []),
      json(result.drivers, []),
      json(result.indicators, []),
      json(result.risk, {}),
      json(result.analytics, {}),
      json(result.sourceWindow, {}),
      result.evidenceHash,
      result.calculationVersion || INTELLIGENCE_VERSION,
    ]
  );
  return mapProjectRow(rows[0]);
}

export async function saveTeamIntelligence(result) {
  const { rows } = await pool.query(
    `INSERT INTO team_intelligence
      (workspace_id, team_key, manager_id, score, band, trend, confidence, indexes,
       strengths, concerns, drivers, indicators, risk, analytics, source_window,
       evidence_hash, calculation_version, last_evaluated_at)
     VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now())
     ON CONFLICT (workspace_id, team_key)
     DO UPDATE SET
       manager_id = EXCLUDED.manager_id,
       score = EXCLUDED.score,
       band = EXCLUDED.band,
       trend = EXCLUDED.trend,
       confidence = EXCLUDED.confidence,
       indexes = EXCLUDED.indexes,
       strengths = EXCLUDED.strengths,
       concerns = EXCLUDED.concerns,
       drivers = EXCLUDED.drivers,
       indicators = EXCLUDED.indicators,
       risk = EXCLUDED.risk,
       analytics = EXCLUDED.analytics,
       source_window = EXCLUDED.source_window,
       evidence_hash = EXCLUDED.evidence_hash,
       calculation_version = EXCLUDED.calculation_version,
       last_evaluated_at = now(),
       updated_at = now()
     RETURNING *`,
    [
      result.workspaceId,
      result.teamKey,
      result.managerId || null,
      result.score,
      result.band,
      result.trend,
      result.confidence,
      json(result.indexes, {}),
      json(result.strengths, []),
      json(result.concerns, []),
      json(result.drivers, []),
      json(result.indicators, []),
      json(result.risk, {}),
      json(result.analytics, {}),
      json(result.sourceWindow, {}),
      result.evidenceHash,
      result.calculationVersion || INTELLIGENCE_VERSION,
    ]
  );
  return mapTeamRow(rows[0]);
}

export async function saveWorkspaceIntelligence(result) {
  const { rows } = await pool.query(
    `INSERT INTO workspace_intelligence
      (workspace_id, score, band, trend, confidence, indexes,
       strengths, concerns, drivers, indicators, risk, analytics, source_window,
       evidence_hash, calculation_version, last_evaluated_at)
     VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
     ON CONFLICT (workspace_id)
     DO UPDATE SET
       score = EXCLUDED.score,
       band = EXCLUDED.band,
       trend = EXCLUDED.trend,
       confidence = EXCLUDED.confidence,
       indexes = EXCLUDED.indexes,
       strengths = EXCLUDED.strengths,
       concerns = EXCLUDED.concerns,
       drivers = EXCLUDED.drivers,
       indicators = EXCLUDED.indicators,
       risk = EXCLUDED.risk,
       analytics = EXCLUDED.analytics,
       source_window = EXCLUDED.source_window,
       evidence_hash = EXCLUDED.evidence_hash,
       calculation_version = EXCLUDED.calculation_version,
       last_evaluated_at = now(),
       updated_at = now()
     RETURNING *`,
    [
      result.workspaceId,
      result.score,
      result.band,
      result.trend,
      result.confidence,
      json(result.indexes, {}),
      json(result.strengths, []),
      json(result.concerns, []),
      json(result.drivers, []),
      json(result.indicators, []),
      json(result.risk, {}),
      json(result.analytics, {}),
      json(result.sourceWindow, {}),
      result.evidenceHash,
      result.calculationVersion || INTELLIGENCE_VERSION,
    ]
  );
  return mapWorkspaceRow(rows[0]);
}

export async function writeSnapshot({ scopeType, subjectKey, result, periodKey = "rolling_30d", capturedForDate = null }) {
  await pool.query(
    `INSERT INTO intelligence_snapshots
      (workspace_id, scope_type, subject_key, period_key, captured_for_date,
       score, band, trend, confidence, payload, indicators, calculation_version)
     VALUES
      ($1,$2,$3,$4,COALESCE($5::date, CURRENT_DATE),$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (workspace_id, scope_type, subject_key, period_key, captured_for_date)
     DO UPDATE SET
       score = EXCLUDED.score,
       band = EXCLUDED.band,
       trend = EXCLUDED.trend,
       confidence = EXCLUDED.confidence,
       payload = EXCLUDED.payload,
       indicators = EXCLUDED.indicators,
       calculation_version = EXCLUDED.calculation_version,
       captured_at = now()`,
    [
      result.workspaceId,
      scopeType,
      subjectKey,
      periodKey,
      capturedForDate,
      result.score,
      result.band,
      result.trend,
      result.confidence,
      json(result, {}),
      json(result.indicators, []),
      result.calculationVersion || INTELLIGENCE_VERSION,
    ]
  );
}

export async function recordRecalculationEvent({ workspaceId, reason, sourceType = null, sourceId = null, userIds = [], projectIds = [], teamKeys = [], status = "completed", error = null, metadata = {} }) {
  await pool.query(
    `INSERT INTO intelligence_recalculation_events
      (workspace_id, reason, source_type, source_id, user_ids, project_ids, team_keys, status, error, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      workspaceId,
      reason,
      sourceType,
      sourceId,
      userIds,
      projectIds,
      teamKeys,
      status,
      error,
      json(metadata, {}),
    ]
  ).catch(() => {});
}

export async function getUserIntelligence({ workspaceId, userId }) {
  const { rows } = await pool.query(
    `SELECT ui.*, u.username
     FROM user_intelligence ui
     LEFT JOIN users u ON u.id = ui.user_id
     WHERE ui.workspace_id = $1 AND ui.user_id = $2
     LIMIT 1`,
    [workspaceId, userId]
  );
  return mapUserRow(rows[0]);
}

export async function listUserIntelligence({ workspaceId, userIds = null }) {
  const params = [workspaceId];
  let clause = "";
  if (Array.isArray(userIds) && userIds.length > 0) {
    clause = "AND ui.user_id = ANY($2::uuid[])";
    params.push(userIds);
  }
  const { rows } = await pool.query(
    `SELECT ui.*, u.username
     FROM user_intelligence ui
     LEFT JOIN users u ON u.id = ui.user_id
     WHERE ui.workspace_id = $1 ${clause}
     ORDER BY ui.score DESC, u.username ASC`,
    params
  );
  return rows.map(mapUserRow);
}

export async function getProjectIntelligence({ workspaceId, projectId }) {
  const { rows } = await pool.query(
    `SELECT pi.*, p.name AS project_name
     FROM project_intelligence pi
     LEFT JOIN projects p ON p.id = pi.project_id
     WHERE pi.workspace_id = $1 AND pi.project_id = $2
     LIMIT 1`,
    [workspaceId, projectId]
  );
  return mapProjectRow(rows[0]);
}

export async function listProjectIntelligence({ workspaceId, projectIds = null }) {
  const params = [workspaceId];
  let clause = "";
  if (Array.isArray(projectIds) && projectIds.length > 0) {
    clause = "AND pi.project_id = ANY($2::uuid[])";
    params.push(projectIds);
  }
  const { rows } = await pool.query(
    `SELECT pi.*, p.name AS project_name
     FROM project_intelligence pi
     LEFT JOIN projects p ON p.id = pi.project_id
     WHERE pi.workspace_id = $1 ${clause}
     ORDER BY pi.score DESC, p.name ASC`,
    params
  );
  return rows.map(mapProjectRow);
}

export async function getTeamIntelligence({ workspaceId, teamKey }) {
  const { rows } = await pool.query(
    `SELECT ti.*, u.username AS manager_name
     FROM team_intelligence ti
     LEFT JOIN users u ON u.id = ti.manager_id
     WHERE ti.workspace_id = $1 AND ti.team_key = $2
     LIMIT 1`,
    [workspaceId, teamKey]
  );
  return mapTeamRow(rows[0]);
}

export async function listTeamIntelligence({ workspaceId, teamKeys = null }) {
  const params = [workspaceId];
  let clause = "";
  if (Array.isArray(teamKeys) && teamKeys.length > 0) {
    clause = "AND ti.team_key = ANY($2)";
    params.push(teamKeys);
  }
  const { rows } = await pool.query(
    `SELECT ti.*, u.username AS manager_name
     FROM team_intelligence ti
     LEFT JOIN users u ON u.id = ti.manager_id
     WHERE ti.workspace_id = $1 ${clause}
     ORDER BY ti.score DESC, u.username ASC`,
    params
  );
  return rows.map(mapTeamRow);
}

export async function getWorkspaceIntelligence({ workspaceId }) {
  const { rows } = await pool.query(
    `SELECT * FROM workspace_intelligence WHERE workspace_id = $1 LIMIT 1`,
    [workspaceId]
  );
  return mapWorkspaceRow(rows[0]);
}

export async function getSnapshotSeries({
  workspaceId,
  scopeType,
  subjectKey,
  range = "30d",
  periodKey = "rolling_30d",
  startDate = null,
  endDate = null,
}) {
  const daysByRange = {
    "30d": 30,
    "90d": 90,
    "6m": 183,
    "1y": 366,
  };

  const params = [workspaceId, scopeType, subjectKey, periodKey];
  let dateClause = "";

  if (range === "custom" && startDate && endDate) {
    dateClause = "AND captured_for_date BETWEEN $5::date AND $6::date";
    params.push(startDate);
    params.push(endDate);
  } else if (range !== "all") {
    const days = daysByRange[range] || daysByRange["30d"];
    dateClause = "AND captured_for_date >= CURRENT_DATE - ($5::int * INTERVAL '1 day')";
    params.push(days);
  }

  const { rows } = await pool.query(
    `SELECT captured_for_date, captured_at, score, band, trend, confidence, payload, indicators
     FROM intelligence_snapshots
     WHERE workspace_id = $1
       AND scope_type = $2
       AND subject_key = $3
       AND period_key = $4
       ${dateClause}
     ORDER BY captured_for_date ASC`,
    params
  );

  return rows.map((row) => {
    const time = snapshotTimeModel(row);
    return {
      date: row.captured_for_date,
      score: Number(row.score) || 0,
      band: row.band,
      trend: row.trend,
      confidence: Number(row.confidence) || 0,
      payload: row.payload || {},
      indicators: row.indicators || [],
      computedAt: time.computedAt,
      coverageStart: time.coverageStart,
      coverageEnd: time.coverageEnd,
      attendanceClosedThroughDate: time.attendanceClosedThroughDate,
      snapshotDate: time.snapshotDate,
      intelligenceMode: time.intelligenceMode,
      time,
    };
  });
}

export default {
  hasEnterpriseIntelligenceSchema,
  saveUserIntelligence,
  saveProjectIntelligence,
  saveTeamIntelligence,
  saveWorkspaceIntelligence,
  writeSnapshot,
  recordRecalculationEvent,
  getUserIntelligence,
  listUserIntelligence,
  getProjectIntelligence,
  listProjectIntelligence,
  getTeamIntelligence,
  listTeamIntelligence,
  getWorkspaceIntelligence,
  getSnapshotSeries,
};
