import pool from "../../db.js";
import { getRangeFromWindow, getWorkspaceCalendar } from "./calendar.service.js";

const COMPLETED_STATUSES = ["completed", "done", "closed"];
const OPEN_STATUSES = ["pending", "in-progress", "in_progress", "backlog"];

function dateKey(value) {
  return value ? String(value).slice(0, 10) : null;
}

function minDateKey(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return a <= b ? a : b;
}

function emptyCalendar() {
  return {
    workDayNums: [],
    holidayDates: new Set(),
    leaveCapacityByDate: new Map(),
    dayContexts: [],
    expectedWorkingDays: [],
    nonWorkingDays: [],
    holidayCount: 0,
    approvedLeaveDays: 0,
  };
}

function rowsByDate(rows = [], field = "date") {
  const map = new Map();
  for (const row of rows) {
    const key = dateKey(row[field]);
    if (!key) continue;
    map.set(key, row);
  }
  return map;
}

export async function collectUserEvidence({ workspaceId, userId, windowDays = 30, now = new Date() }) {
  const range = getRangeFromWindow(windowDays, now);
  const priorEnd = new Date(range.start);
  priorEnd.setUTCDate(priorEnd.getUTCDate() - 1);
  priorEnd.setUTCHours(23, 59, 59, 999);
  const priorStart = new Date(priorEnd);
  priorStart.setUTCDate(priorStart.getUTCDate() - range.windowDays + 1);
  priorStart.setUTCHours(0, 0, 0, 0);

  const { rows: attendanceCloseRows } = await pool.query(
    `SELECT MAX(date)::text AS closed_through
     FROM attendance_daily
     WHERE workspace_id = $1
       AND date BETWEEN $2 AND $3`,
    [workspaceId, range.startDate, range.endDate]
  ).catch(() => ({ rows: [] }));

  const attendanceClosedThroughDate = dateKey(attendanceCloseRows[0]?.closed_through);
  const attendanceCoverageEndDate = minDateKey(range.endDate, attendanceClosedThroughDate);
  const attendanceCoverageStartDate = attendanceCoverageEndDate ? range.startDate : null;
  const calendar = attendanceCoverageEndDate
    ? await getWorkspaceCalendar({
      workspaceId,
      userId,
      startDate: attendanceCoverageStartDate,
      endDate: attendanceCoverageEndDate,
    })
    : emptyCalendar();

  const [
    attendance,
    attendanceEvents,
    tasks,
    priorTasks,
    timeLogs,
    comments,
    watchers,
    taskLinks,
    reviews,
    activity,
  ] = await Promise.all([
    pool.query(
      `SELECT *
       FROM attendance_daily
       WHERE workspace_id = $1
         AND user_id = $2
         AND date BETWEEN $3 AND $4
       ORDER BY date ASC`,
      [workspaceId, userId, attendanceCoverageStartDate || range.startDate, attendanceCoverageEndDate || range.startDate]
    ).then((r) => r.rows).catch(() => []),
    pool.query(
      `SELECT event_type, started_at, ended_at
       FROM attendance_events
       WHERE workspace_id = $1
         AND user_id = $2
         AND started_at >= $3::timestamptz
         AND started_at <= $4::timestamptz
       ORDER BY started_at ASC`,
      [
        workspaceId,
        userId,
        attendanceCoverageStartDate ? `${attendanceCoverageStartDate}T00:00:00.000Z` : range.start,
        attendanceCoverageEndDate ? `${attendanceCoverageEndDate}T23:59:59.999Z` : range.start,
      ]
    ).then((r) => r.rows).catch(() => []),
    pool.query(
      `SELECT *
       FROM tasks
       WHERE workspace_id = $1
         AND (
           assigned_to = $2
           OR added_by = $2::text
         )
         AND created_at <= $4::timestamptz
         AND (
           created_at >= $3::timestamptz
           OR updated_at >= $3::timestamptz
           OR status NOT IN ('completed', 'done', 'closed', 'cancelled')
         )`,
      [workspaceId, userId, range.start, range.end]
    ).then((r) => r.rows).catch(() => []),
    pool.query(
      `SELECT *
       FROM tasks
       WHERE workspace_id = $1
         AND assigned_to = $2
         AND created_at >= $3::timestamptz
         AND created_at <= $4::timestamptz`,
      [workspaceId, userId, priorStart, priorEnd]
    ).then((r) => r.rows).catch(() => []),
    pool.query(
      `SELECT tl.*, t.project_id, t.status, t.estimation_hours, t.completed_at
       FROM time_logs tl
       JOIN tasks t ON t.id = tl.task_id
       WHERE tl.workspace_id = $1
         AND tl.user_id = $2
         AND tl.log_date BETWEEN $3 AND $4`,
      [workspaceId, userId, range.startDate, range.endDate]
    ).then((r) => r.rows).catch(() => []),
    pool.query(
      `SELECT c.*, t.project_id, t.assigned_to
       FROM comments c
       JOIN tasks t ON t.id = c.task_id
       WHERE t.workspace_id = $1
         AND c.added_by = $2
         AND c.created_at >= $3::timestamptz
         AND c.created_at <= $4::timestamptz`,
      [workspaceId, userId, range.start, range.end]
    ).then((r) => r.rows).catch(() => []),
    pool.query(
      `SELECT tw.*, t.project_id
       FROM task_watchers tw
       JOIN tasks t ON t.id = tw.task_id
       WHERE tw.workspace_id = $1
         AND tw.user_id = $2
         AND tw.created_at >= $3::timestamptz
         AND tw.created_at <= $4::timestamptz`,
      [workspaceId, userId, range.start, range.end]
    ).then((r) => r.rows).catch(() => []),
    pool.query(
      `SELECT tl.*, t.assigned_to, t.status, t.completed_at
       FROM task_links tl
       JOIN tasks t ON t.id = tl.target_task_id
       WHERE tl.workspace_id = $1
         AND t.assigned_to = $2
         AND tl.created_at <= $4::timestamptz
         AND (
           tl.created_at >= $3::timestamptz
           OR t.updated_at >= $3::timestamptz
           OR t.status NOT IN ('completed', 'done', 'closed')
         )`,
      [workspaceId, userId, range.start, range.end]
    ).then((r) => r.rows).catch(() => []),
    pool.query(
      `SELECT pr.*, rc.start_date, rc.end_date
       FROM performance_reviews pr
       JOIN review_cycles rc ON rc.id = pr.cycle_id
       WHERE rc.workspace_id = $1
         AND (pr.reviewee_id = $2 OR pr.reviewer_id = $2)
         AND rc.end_date >= $3::date
         AND rc.start_date <= $4::date`,
      [workspaceId, userId, range.startDate, range.endDate]
    ).then((r) => r.rows).catch(() => []),
    pool.query(
      `SELECT *
       FROM task_activity_logs
       WHERE workspace_id = $1
         AND actor_id = $2
         AND created_at >= $3::timestamptz
         AND created_at <= $4::timestamptz`,
      [workspaceId, userId, range.start, range.end]
    ).then((r) => r.rows).catch(() => []),
  ]);

  const attendanceByDate = rowsByDate(attendance);
  const deliveryByDate = new Map();
  for (const task of tasks) {
    if (
      String(task.assigned_to || "") === String(userId) &&
      COMPLETED_STATUSES.includes(String(task.status || "").toLowerCase()) &&
      task.completed_at
    ) {
      const key = dateKey(task.completed_at);
      if (!key) continue;
      const existing = deliveryByDate.get(key) || { completedTasks: 0, storyPoints: 0, blockerResolutions: 0 };
      existing.completedTasks += 1;
      existing.storyPoints += Number(task.story_points) || 0;
      deliveryByDate.set(key, existing);
    }
  }
  for (const log of timeLogs) {
    const key = dateKey(log.log_date);
    if (!key) continue;
    const existing = deliveryByDate.get(key) || { completedTasks: 0, storyPoints: 0, blockerResolutions: 0 };
    existing.timeLogHours = (existing.timeLogHours || 0) + (Number(log.hours) || 0);
    deliveryByDate.set(key, existing);
  }
  for (const link of taskLinks) {
    if (!COMPLETED_STATUSES.includes(String(link.status || "").toLowerCase()) || !link.completed_at) continue;
    const key = dateKey(link.completed_at);
    if (!key) continue;
    const existing = deliveryByDate.get(key) || { completedTasks: 0, storyPoints: 0, blockerResolutions: 0 };
    existing.blockerResolutions = (existing.blockerResolutions || 0) + 1;
    deliveryByDate.set(key, existing);
  }

  return {
    workspaceId,
    userId,
    range,
    priorRange: {
      start: priorStart,
      end: priorEnd,
      startDate: priorStart.toISOString().slice(0, 10),
      endDate: priorEnd.toISOString().slice(0, 10),
    },
    calendar,
    attendanceClosedThroughDate,
    attendanceCoverage: {
      startDate: attendanceCoverageStartDate,
      endDate: attendanceCoverageEndDate,
    },
    attendance,
    attendanceByDate,
    attendanceEvents,
    tasks,
    priorTasks,
    timeLogs,
    comments,
    watchers,
    taskLinks,
    reviews,
    activity,
    deliveryByDate,
    statusSets: { completed: COMPLETED_STATUSES, open: OPEN_STATUSES },
  };
}

export async function collectProjectEvidence({ workspaceId, projectId, windowDays = 30, now = new Date() }) {
  const range = getRangeFromWindow(windowDays, now);
  const { rows: tasks } = await pool.query(
    `SELECT *
     FROM tasks
     WHERE workspace_id = $1
       AND project_id = $2
       AND created_at <= $4::timestamptz
       AND (
         created_at >= $3::timestamptz
         OR updated_at >= $3::timestamptz
         OR status NOT IN ('completed', 'done', 'closed', 'cancelled')
       )`,
    [workspaceId, projectId, range.start, range.end]
  ).catch(() => ({ rows: [] }));

  const { rows: links } = await pool.query(
    `SELECT tl.*
     FROM task_links tl
     JOIN tasks t ON t.id = tl.source_task_id OR t.id = tl.target_task_id
     WHERE tl.workspace_id = $1
       AND t.project_id = $2
       AND tl.created_at <= $3::timestamptz`,
    [workspaceId, projectId, range.end]
  ).catch(() => ({ rows: [] }));

  const { rows: sprints } = await pool.query(
    `SELECT *
     FROM sprints
     WHERE workspace_id = $1
       AND project_id = $2
       AND created_at <= $4::timestamptz
       AND (created_at >= $3::timestamptz OR updated_at >= $3::timestamptz OR status != 'completed')`,
    [workspaceId, projectId, range.start, range.end]
  ).catch(() => ({ rows: [] }));

  return {
    workspaceId,
    projectId,
    range,
    tasks,
    links,
    sprints,
    statusSets: { completed: COMPLETED_STATUSES, open: OPEN_STATUSES },
  };
}

export async function collectWorkspaceScope({ workspaceId }) {
  const [users, projects, managers] = await Promise.all([
    pool.query(
      `SELECT DISTINCT wu.user_id AS id, u.username, COALESCE(wu.role, u.role) AS role, wu.manager_id
       FROM workspace_users wu
       JOIN users u ON u.id = wu.user_id
       WHERE wu.workspace_id = $1
         AND COALESCE(u.is_system, false) = false
         AND COALESCE(u.role, '') != 'system'
         AND COALESCE(u.role, '') != 'superadmin'`,
      [workspaceId]
    ).then((r) => r.rows).catch(() => []),
    pool.query(
      `SELECT id, name FROM projects WHERE workspace_id = $1`,
      [workspaceId]
    ).then((r) => r.rows).catch(() => []),
    pool.query(
      `SELECT DISTINCT manager_id
       FROM workspace_users
       WHERE workspace_id = $1
         AND manager_id IS NOT NULL`,
      [workspaceId]
    ).then((r) => r.rows).catch(() => []),
  ]);

  return {
    users,
    projects,
    managers: managers.map((row) => row.manager_id).filter(Boolean),
  };
}

export async function collectWorkspaceEvidence({ workspaceId, windowDays = 30, now = new Date() }) {
  const range = getRangeFromWindow(windowDays, now);
  const [internal, external, externalSignals, assurance] = await Promise.all([
    pool.query(
      `WITH latest_decision_reviews AS (
         SELECT DISTINCT ON (review.decision_id) review.*
         FROM assurance_decision_reviews review
         WHERE review.workspace_id=$1
         ORDER BY review.decision_id, review.reviewed_at DESC, review.id DESC
       )
       SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (
           WHERE LOWER(COALESCE(status, '')) = ANY($2::text[])
             AND completed_at IS NOT NULL
             AND completed_at <= $4::timestamptz
         )::int AS completed
       FROM tasks
       WHERE workspace_id = $1
         AND created_at <= $4::timestamptz
         AND (
           created_at >= $3::timestamptz
           OR updated_at >= $3::timestamptz
           OR status NOT IN ('completed', 'done', 'closed', 'cancelled')
           OR completed_at BETWEEN $3::timestamptz AND $4::timestamptz
         )`,
      [workspaceId, COMPLETED_STATUSES, range.start, range.end]
    ).then((r) => r.rows[0]).catch(() => ({ total: 0, completed: 0 })),
    pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(DISTINCT provider)::int AS provider_count
       FROM integration_entity_state
       WHERE workspace_id = $1
         AND updated_at <= $2::timestamptz`,
      [workspaceId, range.end]
    ).then((r) => r.rows[0]).catch(() => ({ total: 0, provider_count: 0 })),
    pool.query(
      `SELECT
         COUNT(*)::int AS signal_count,
         COUNT(DISTINCT external_id) FILTER (WHERE signal_type = 'INTEGRATION_TASK_COMPLETED')::int AS completed
       FROM workspace_execution_signals
       WHERE workspace_id = $1
         AND created_at >= $2::timestamptz
         AND created_at <= $3::timestamptz`,
      [workspaceId, range.start, range.end]
    ).then((r) => r.rows[0]).catch(() => ({ signal_count: 0, completed: 0 })),
    pool.query(
      `SELECT
         COALESCE((
           SELECT minimum_pattern_sample
           FROM assurance_workspace_policies
           WHERE workspace_id = $1
         ), 3)::int AS required_sample_size,
         (SELECT COUNT(*)::int
          FROM okr_objectives o
          WHERE o.workspace_id = $1
            AND o.success_measure IS NOT NULL
            AND o.target_date IS NOT NULL) AS outcome_count,
         (SELECT COUNT(DISTINCT e.goal_id)::int
          FROM goal_assurance_evidence e
          JOIN okr_objectives o
            ON o.workspace_id = e.workspace_id AND o.id = e.goal_id
          WHERE e.workspace_id = $1
            AND o.success_measure IS NOT NULL
            AND o.target_date IS NOT NULL) AS outcomes_with_evidence,
         (SELECT COUNT(*)::int
          FROM assurance_outcome_observations observation
          WHERE observation.workspace_id = $1) AS verified_sample_size,
         (SELECT COUNT(*)::int
          FROM assurance_outcome_observations observation
          WHERE observation.workspace_id = $1
            AND observation.on_time IS TRUE) AS verified_on_time_count,
         (SELECT COUNT(*)::int
          FROM assurance_state_snapshots snapshot
          WHERE snapshot.workspace_id = $1) AS snapshotted_outcome_count,
         (SELECT COUNT(*)::int
          FROM assurance_state_snapshots snapshot
          WHERE snapshot.workspace_id = $1
            AND snapshot.state IN ('on_track', 'verified')) AS healthy_outcome_count,
         (SELECT COUNT(*)::int
          FROM assurance_state_snapshots snapshot
          WHERE snapshot.workspace_id = $1
            AND snapshot.state IN ('at_risk', 'off_track', 'needs_evidence')) AS attention_outcome_count,
         (SELECT COUNT(*)::int FROM assurance_decisions decision
          WHERE decision.workspace_id=$1 AND decision.status='decided') AS explicit_decision_count,
         (SELECT COUNT(DISTINCT decision.id)::int FROM assurance_decisions decision
          JOIN latest_decision_reviews review
            ON review.workspace_id=decision.workspace_id AND review.decision_id=decision.id
          WHERE decision.workspace_id=$1) AS reviewed_decision_count,
         (SELECT COUNT(*)::int FROM latest_decision_reviews review
          WHERE review.workspace_id=$1 AND review.effectiveness='effective') AS effective_decision_count,
         (SELECT COUNT(*)::int FROM latest_decision_reviews review
          WHERE review.workspace_id=$1 AND review.effectiveness='mixed') AS mixed_decision_count,
         (SELECT COUNT(*)::int FROM assurance_experiments experiment
          WHERE experiment.workspace_id=$1 AND experiment.status IN ('planned','active')) AS active_experiment_count,
         (SELECT COUNT(*)::int FROM assurance_experiments experiment
          WHERE experiment.workspace_id=$1 AND experiment.status='completed') AS completed_experiment_count,
         (SELECT COUNT(*)::int FROM assurance_experiments experiment
          WHERE experiment.workspace_id=$1 AND experiment.result_status='supported') AS supported_experiment_count,
         (SELECT COUNT(*)::int FROM assurance_scenario_analyses scenario
          WHERE scenario.workspace_id=$1) AS scenario_analysis_count,
         (SELECT COUNT(*)::int FROM assurance_outcome_receipts receipt
          WHERE receipt.workspace_id=$1) AS outcome_receipt_count,
         (SELECT COUNT(*)::int FROM assurance_policy_proposals proposal
          WHERE proposal.workspace_id=$1 AND proposal.status='candidate') AS policy_proposal_count`,
      [workspaceId]
    ).then((r) => r.rows[0]).catch(() => ({
      required_sample_size: 3,
      outcome_count: 0,
      outcomes_with_evidence: 0,
      verified_sample_size: 0,
      verified_on_time_count: 0,
      snapshotted_outcome_count: 0,
      healthy_outcome_count: 0,
      attention_outcome_count: 0,
      explicit_decision_count: 0,
      reviewed_decision_count: 0,
      effective_decision_count: 0,
      mixed_decision_count: 0,
      active_experiment_count: 0,
      completed_experiment_count: 0,
      supported_experiment_count: 0,
      scenario_analysis_count: 0,
      outcome_receipt_count: 0,
      policy_proposal_count: 0,
    })),
  ]);

  const internalTotal = Number(internal?.total) || 0;
  const internalCompleted = Number(internal?.completed) || 0;
  const externalTotal = Number(external?.total) || 0;
  const externalCompleted = Math.min(Number(externalSignals?.completed) || 0, externalTotal);
  const totalWork = internalTotal + externalTotal;
  const completedWork = internalCompleted + externalCompleted;
  const requiredSampleSize = Math.max(3, Number(assurance?.required_sample_size) || 3);
  const verifiedSampleSize = Number(assurance?.verified_sample_size) || 0;

  return {
    execution: {
      internalTotal,
      internalCompleted,
      externalTotal,
      externalCompleted,
      totalWork,
      completedWork,
      externalProviderCount: Number(external?.provider_count) || 0,
      externalSignalCount: Number(externalSignals?.signal_count) || 0,
    },
    assurance: {
      eligible: verifiedSampleSize >= requiredSampleSize,
      requiredSampleSize,
      outcomeCount: Number(assurance?.outcome_count) || 0,
      outcomesWithEvidence: Number(assurance?.outcomes_with_evidence) || 0,
      verifiedSampleSize,
      verifiedOnTimeCount: Number(assurance?.verified_on_time_count) || 0,
      snapshottedOutcomeCount: Number(assurance?.snapshotted_outcome_count) || 0,
      healthyOutcomeCount: Number(assurance?.healthy_outcome_count) || 0,
      attentionOutcomeCount: Number(assurance?.attention_outcome_count) || 0,
      explicitDecisionCount: Number(assurance?.explicit_decision_count) || 0,
      reviewedDecisionCount: Number(assurance?.reviewed_decision_count) || 0,
      effectiveDecisionCount: Number(assurance?.effective_decision_count) || 0,
      mixedDecisionCount: Number(assurance?.mixed_decision_count) || 0,
      activeExperimentCount: Number(assurance?.active_experiment_count) || 0,
      completedExperimentCount: Number(assurance?.completed_experiment_count) || 0,
      supportedExperimentCount: Number(assurance?.supported_experiment_count) || 0,
      scenarioAnalysisCount: Number(assurance?.scenario_analysis_count) || 0,
      outcomeReceiptCount: Number(assurance?.outcome_receipt_count) || 0,
      policyProposalCount: Number(assurance?.policy_proposal_count) || 0,
    },
    sourceWindow: {
      startDate: range.startDate,
      endDate: range.endDate,
      windowDays: range.windowDays,
    },
  };
}
