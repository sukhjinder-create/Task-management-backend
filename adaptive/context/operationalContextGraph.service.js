import pool from "../../db.js";
import { isUuid } from "../shared/runtimeUtils.js";

async function rows(sql, params = []) {
  return (await pool.query(sql, params)).rows;
}

function first(items) { return items?.[0] || null; }

export async function buildOperationalContextGraph({ event, settings }) {
  const workspaceId = event.workspaceId;
  const eventEntityId = isUuid(event.entityId) ? event.entityId : null;
  const task = event.entityType === "task" && eventEntityId
    ? first(await rows(`SELECT * FROM tasks WHERE id = $1 AND workspace_id = $2`, [eventEntityId, workspaceId]))
    : null;
  const projectId = task?.project_id
    || (event.entityType === "project" ? eventEntityId : null)
    || (isUuid(event.metadata?.projectId) ? event.metadata.projectId : null)
    || (isUuid(event.metadata?.request?.project_id) ? event.metadata.request.project_id : null)
    || (isUuid(event.metadata?.request?.projectId) ? event.metadata.request.projectId : null);
  const project = projectId
    ? first(await rows(`SELECT * FROM projects WHERE id = $1 AND workspace_id = $2`, [projectId, workspaceId]))
    : null;
  const userId = task?.assigned_to
    || (isUuid(event.metadata?.userId) ? event.metadata.userId : null)
    || (isUuid(event.actorUserId) ? event.actorUserId : null);
  const scopedIds = [
    userId, projectId, event.metadata?.teamId, event.metadata?.departmentId, event.metadata?.enterpriseId,
  ].filter(isUuid);
  const limit = Math.min(Math.max(Number(settings?.context_limits?.relatedEntities) || 20, 5), 50);

  const [dependencies, sprint, leave, attendance, recommendations, outcomes, meetings,
    goals, reviews, knowledge, workload, riskHistory, summaries, policies, behaviourProfiles] = await Promise.all([
    task?.id ? rows(
      `SELECT l.id, l.link_type, l.source_task_id, l.target_task_id,
              s.task AS source_title, s.status AS source_status,
              t.task AS target_title, t.status AS target_status
       FROM task_links l
       JOIN tasks s ON s.id = l.source_task_id
       JOIN tasks t ON t.id = l.target_task_id
       WHERE l.workspace_id = $1 AND (l.source_task_id = $2 OR l.target_task_id = $2)
       ORDER BY l.created_at DESC LIMIT $3`, [workspaceId, task.id, limit]) : [],
    task?.sprint_id ? rows(`SELECT * FROM sprints WHERE id = $1 AND workspace_id = $2`, [task.sprint_id, workspaceId]) : [],
    userId ? rows(
      `SELECT lr.id, lr.user_id, lr.start_date, lr.end_date, lr.status, lt.name AS leave_type
       FROM leave_requests lr LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
       WHERE lr.workspace_id = $1 AND lr.user_id = $2 AND lr.status = 'approved'
         AND lr.end_date >= CURRENT_DATE - 7 AND lr.start_date <= CURRENT_DATE + 30
       ORDER BY lr.start_date LIMIT $3`, [workspaceId, userId, limit]) : [],
    userId ? rows(
      `SELECT * FROM attendance_daily WHERE workspace_id = $1 AND user_id = $2
       ORDER BY date DESC LIMIT 14`, [workspaceId, userId]) : [],
    rows(
      `SELECT id, status, action_type, capability_key, confidence, risk_level, project_id,
              task_id, created_at, executed_at, result, approval_mode
       FROM operations_ai_actions WHERE workspace_id = $1
         AND ($2::uuid IS NULL OR project_id = $2)
         AND ($3::uuid IS NULL OR task_id = $3)
       ORDER BY created_at DESC LIMIT $4`, [workspaceId, projectId, task?.id || null, limit]),
    rows(
      `SELECT signal_key, signal_value, confidence, created_at, scope_type, scope_id
       FROM adaptive_learning_signals WHERE workspace_id = $1 AND status = 'active'
         AND ($2::uuid IS NULL OR scope_id = $2 OR scope_type = 'workspace')
       ORDER BY created_at DESC LIMIT $3`, [workspaceId, projectId, limit]),
    rows(
      `SELECT d.id, d.session_id, d.digest_type, d.status, d.digest_json, d.provenance_json,
              d.created_at
       FROM huddle_meeting_digests d
       WHERE d.workspace_id = $1 ORDER BY d.created_at DESC LIMIT $2`, [workspaceId, Math.min(limit, 10)]),
    rows(`SELECT * FROM okr_objectives WHERE workspace_id = $1 ORDER BY updated_at DESC LIMIT $2`, [workspaceId, limit]),
    rows(
      `SELECT pr.id, pr.status, pr.overall_score, pr.reviewee_id, pr.reviewer_id, pr.updated_at
       FROM performance_reviews pr JOIN review_cycles rc ON rc.id = pr.cycle_id
       WHERE rc.workspace_id = $1 ORDER BY pr.updated_at DESC LIMIT $2`, [workspaceId, limit]),
    rows(
      `SELECT p.id, p.title, p.updated_at, s.name AS space_name
       FROM wiki_pages p JOIN wiki_spaces s ON s.id = p.space_id
       WHERE s.workspace_id = $1 ORDER BY p.updated_at DESC LIMIT $2`, [workspaceId, Math.min(limit, 10)]),
    rows(
      `SELECT assigned_to AS user_id,
              COUNT(*) FILTER (WHERE status NOT IN ('completed','done','closed'))::int AS active_tasks,
              COUNT(*) FILTER (WHERE due_date < CURRENT_DATE AND status NOT IN ('completed','done','closed'))::int AS overdue_tasks,
              COUNT(*) FILTER (WHERE is_blocked = TRUE)::int AS blocked_tasks
       FROM tasks WHERE workspace_id = $1 AND assigned_to IS NOT NULL
       GROUP BY assigned_to ORDER BY active_tasks DESC LIMIT $2`, [workspaceId, limit]),
    rows(
      `SELECT event_type, entity_type, entity_id, metadata, occurred_at
       FROM workspace_events WHERE workspace_id = $1
         AND ($2::uuid IS NULL OR entity_id = $2 OR metadata->>'projectId' = $2::text)
       ORDER BY occurred_at DESC LIMIT $3`, [workspaceId, task?.id || projectId, limit]),
    rows(
      `SELECT * FROM (
         SELECT id, digest_type, status, NULL::text AS period, summary,
                content AS source_data, created_at AS generated_at, 'workspace_digest'::text AS source
         FROM workspace_digest_runs WHERE workspace_id = $1
         UNION ALL
         SELECT id, 'executive_summary'::text AS digest_type, status, period, summary,
                source_data, created_at AS generated_at, 'executive_summary'::text AS source
         FROM workspace_executive_summaries WHERE workspace_id = $1
       ) summaries ORDER BY generated_at DESC LIMIT 10`, [workspaceId]),
    rows(
      `SELECT wu.user_id, u.role, wu.billing_status
       FROM workspace_users wu JOIN users u ON u.id = wu.user_id
       WHERE wu.workspace_id = $1 AND wu.user_id = $2 LIMIT 1`, [workspaceId, event.actorUserId || null]),
    rows(
      `SELECT scope_type, scope_id, profile_key, profile_value, confidence,
              sample_count, version, explanation, last_signal_at
       FROM adaptive_preference_profiles
       WHERE workspace_id = $1
         AND (scope_id IS NULL OR scope_id = ANY($2::uuid[]))
       ORDER BY CASE scope_type
         WHEN 'user' THEN 1 WHEN 'team' THEN 2 WHEN 'project' THEN 3
         WHEN 'department' THEN 4 WHEN 'workspace' THEN 5 WHEN 'enterprise' THEN 6 ELSE 7 END,
         sample_count DESC`, [workspaceId, scopedIds]),
  ]);

  const graph = {
    task,
    project,
    sprint: first(sprint),
    dependencies,
    availability: { leave, attendance },
    previousRecommendations: recommendations,
    previousOutcomes: outcomes,
    meetings,
    goals,
    reviews,
    knowledge,
    workload,
    riskHistory,
    executiveSummaries: summaries,
    permissions: first(policies),
    behaviourProfiles,
  };
  const populated = Object.entries(graph)
    .filter(([, value]) => Array.isArray(value) ? value.length : value != null)
    .map(([key]) => key);
  return {
    ...graph,
    relevance: {
      eventType: event.eventType,
      projectId,
      taskId: task?.id || null,
      userId,
      populated,
      rationale: "Related entities were selected by tenant, event entity, project, task, assignee, and recency.",
    },
  };
}
