import pool from "../../db.js";
import {
  INTELLIGENCE_VERSION,
  compactJson,
} from "./scorePrimitives.js";
import {
  collectProjectEvidence,
  collectUserEvidence,
  collectWorkspaceEvidence,
  collectWorkspaceScope,
} from "./evidenceCollector.js";
import { evaluateUserIntelligence } from "../evaluators/userEvaluator.js";
import { evaluateProjectIntelligence } from "../evaluators/projectEvaluator.js";
import { evaluateTeamIntelligence } from "../evaluators/teamEvaluator.js";
import { evaluateWorkspaceIntelligence } from "../evaluators/workspaceEvaluator.js";
import {
  getProjectIntelligence,
  getTeamIntelligence,
  getUserIntelligence,
  getWorkspaceIntelligence,
  hasEnterpriseIntelligenceSchema,
  listProjectIntelligence,
  listTeamIntelligence,
  listUserIntelligence,
  recordRecalculationEvent,
  saveProjectIntelligence,
  saveTeamIntelligence,
  saveUserIntelligence,
  saveWorkspaceIntelligence,
  writeSnapshot,
} from "../repositories/unifiedIntelligence.repository.js";

const DEFAULT_WINDOW_DAYS = 30;

async function assertSchema() {
  if (!(await hasEnterpriseIntelligenceSchema())) {
    const err = new Error("Enterprise intelligence tables are not installed. Run run-enterprise-intelligence-migration.js locally before switching dashboards.");
    err.code = "INTELLIGENCE_SCHEMA_MISSING";
    throw err;
  }
}

function withVersion(result) {
  return {
    ...result,
    calculationVersion: result.calculationVersion || INTELLIGENCE_VERSION,
  };
}

export async function evaluateAndPersistUser({ workspaceId, userId, windowDays = DEFAULT_WINDOW_DAYS }) {
  await assertSchema();
  const evidence = await collectUserEvidence({ workspaceId, userId, windowDays });
  const result = withVersion(evaluateUserIntelligence(evidence));
  const saved = await saveUserIntelligence(result);
  await writeSnapshot({
    scopeType: "user",
    subjectKey: String(userId),
    result: { ...result, workspaceId },
  });
  return saved;
}

export async function evaluateAndPersistProject({ workspaceId, projectId, windowDays = DEFAULT_WINDOW_DAYS }) {
  await assertSchema();
  const evidence = await collectProjectEvidence({ workspaceId, projectId, windowDays });
  const result = withVersion(evaluateProjectIntelligence(evidence));
  const saved = await saveProjectIntelligence(result);
  await writeSnapshot({
    scopeType: "project",
    subjectKey: String(projectId),
    result: { ...result, workspaceId },
  });
  return saved;
}

async function getTeamMemberIds({ workspaceId, managerId }) {
  const { rows } = await pool.query(
    `SELECT wu.user_id
     FROM workspace_users wu
     WHERE wu.workspace_id = $1
       AND wu.manager_id = $2`,
    [workspaceId, managerId]
  ).catch(() => ({ rows: [] }));
  return rows.map((row) => row.user_id).filter(Boolean);
}

async function getManagerProjectIds({ workspaceId, managerId }) {
  const { rows } = await pool.query(
    `SELECT p.id
     FROM projects p
     JOIN users u ON u.id = $2
     WHERE p.workspace_id = $1
       AND p.id = ANY(u.projects)`,
    [workspaceId, managerId]
  ).catch(() => ({ rows: [] }));
  return rows.map((row) => row.id).filter(Boolean);
}

export async function evaluateAndPersistTeam({ workspaceId, managerId, teamKey = null }) {
  await assertSchema();
  const resolvedTeamKey = teamKey || `manager:${managerId}`;
  const memberIds = managerId ? await getTeamMemberIds({ workspaceId, managerId }) : [];
  const projectIds = managerId ? await getManagerProjectIds({ workspaceId, managerId }) : [];

  const users = memberIds.length > 0
    ? await listUserIntelligence({ workspaceId, userIds: memberIds })
    : [];
  const projects = projectIds.length > 0
    ? await listProjectIntelligence({ workspaceId, projectIds })
    : [];
  const result = withVersion(evaluateTeamIntelligence({
    workspaceId,
    teamKey: resolvedTeamKey,
    managerId,
    users,
    projects,
  }));
  const saved = await saveTeamIntelligence(result);
  await writeSnapshot({
    scopeType: "team",
    subjectKey: resolvedTeamKey,
    result: { ...result, workspaceId },
  });
  return saved;
}

export async function evaluateAndPersistWorkspace({ workspaceId }) {
  await assertSchema();
  const [users, projects, teams, evidence] = await Promise.all([
    listUserIntelligence({ workspaceId }),
    listProjectIntelligence({ workspaceId }),
    listTeamIntelligence({ workspaceId }),
    collectWorkspaceEvidence({ workspaceId }),
  ]);
  const result = withVersion(evaluateWorkspaceIntelligence({
    workspaceId,
    users,
    projects,
    teams,
    evidence,
  }));
  const saved = await saveWorkspaceIntelligence(result);
  await writeSnapshot({
    scopeType: "workspace",
    subjectKey: String(workspaceId),
    result: { ...result, workspaceId },
  });
  return saved;
}

export async function bootstrapWorkspaceIntelligence({ workspaceId, windowDays = DEFAULT_WINDOW_DAYS }) {
  await assertSchema();
  const scope = await collectWorkspaceScope({ workspaceId });

  const userResults = [];
  for (const user of scope.users) {
    userResults.push(await evaluateAndPersistUser({ workspaceId, userId: user.id, windowDays }));
  }

  const projectResults = [];
  for (const project of scope.projects) {
    projectResults.push(await evaluateAndPersistProject({ workspaceId, projectId: project.id, windowDays }));
  }

  const teamResults = [];
  for (const managerId of scope.managers) {
    teamResults.push(await evaluateAndPersistTeam({ workspaceId, managerId }));
  }

  const workspaceResult = await evaluateAndPersistWorkspace({ workspaceId });

  await recordRecalculationEvent({
    workspaceId,
    reason: "workspace_bootstrap",
    userIds: scope.users.map((user) => user.id),
    projectIds: scope.projects.map((project) => project.id),
    teamKeys: scope.managers.map((managerId) => `manager:${managerId}`),
    metadata: {
      calculationVersion: INTELLIGENCE_VERSION,
      userCount: userResults.length,
      projectCount: projectResults.length,
      teamCount: teamResults.length,
    },
  });

  return {
    workspace: workspaceResult,
    users: userResults,
    projects: projectResults,
    teams: teamResults,
  };
}

export async function recalculateImpactedIntelligence({
  workspaceId,
  reason,
  userIds = [],
  projectIds = [],
  managerIds = [],
  sourceType = null,
  sourceId = null,
  metadata = {},
  windowDays = DEFAULT_WINDOW_DAYS,
}) {
  await assertSchema();

  const uniqueUsers = [...new Set(userIds.filter(Boolean).map(String))];
  const uniqueProjects = [...new Set(projectIds.filter(Boolean).map(String))];
  const uniqueManagers = [...new Set(managerIds.filter(Boolean).map(String))];

  const users = [];
  const failures = [];
  for (const userId of uniqueUsers) {
    try {
      users.push(await evaluateAndPersistUser({ workspaceId, userId, windowDays }));
    } catch (err) {
      failures.push({ scope: "user", id: userId, error: err.message });
    }
  }

  const projects = [];
  for (const projectId of uniqueProjects) {
    try {
      projects.push(await evaluateAndPersistProject({ workspaceId, projectId, windowDays }));
    } catch (err) {
      failures.push({ scope: "project", id: projectId, error: err.message });
    }
  }

  const affectedManagers = new Set(uniqueManagers);
  if (uniqueUsers.length > 0) {
    const { rows } = await pool.query(
      `SELECT DISTINCT manager_id
       FROM workspace_users
       WHERE workspace_id = $1
         AND user_id = ANY($2::uuid[])
         AND manager_id IS NOT NULL`,
      [workspaceId, uniqueUsers]
    ).catch(() => ({ rows: [] }));
    rows.forEach((row) => row.manager_id && affectedManagers.add(String(row.manager_id)));
  }
  if (uniqueProjects.length > 0) {
    const { rows } = await pool.query(
      `SELECT DISTINCT u.id AS manager_id
       FROM users u
       WHERE u.workspace_id = $1
         AND u.role = 'manager'
         AND u.projects && $2::uuid[]`,
      [workspaceId, uniqueProjects]
    ).catch(() => ({ rows: [] }));
    rows.forEach((row) => row.manager_id && affectedManagers.add(String(row.manager_id)));
  }

  const teams = [];
  for (const managerId of affectedManagers) {
    try {
      teams.push(await evaluateAndPersistTeam({ workspaceId, managerId }));
    } catch (err) {
      failures.push({ scope: "team", id: managerId, error: err.message });
    }
  }

  if (failures.length > 0) {
    await recordRecalculationEvent({
      workspaceId,
      reason,
      sourceType,
      sourceId,
      userIds: uniqueUsers,
      projectIds: uniqueProjects,
      teamKeys: [...affectedManagers].map((id) => `manager:${id}`),
      status: "failed",
      error: "partial_recalculation_failed",
      metadata: compactJson({
        ...metadata,
        calculationVersion: INTELLIGENCE_VERSION,
        failures,
        staleAggregatePrevention: "workspace_aggregate_not_refreshed_after_partial_failure",
      }),
    });

    const err = new Error("Partial intelligence recalculation failed; workspace aggregate was not refreshed");
    err.code = "INTELLIGENCE_PARTIAL_RECALCULATION_FAILED";
    err.failures = failures;
    throw err;
  }

  const workspace = await evaluateAndPersistWorkspace({ workspaceId });
  await recordRecalculationEvent({
    workspaceId,
    reason,
    sourceType,
    sourceId,
    userIds: uniqueUsers,
    projectIds: uniqueProjects,
    teamKeys: [...affectedManagers].map((id) => `manager:${id}`),
    metadata: compactJson({
      ...metadata,
      calculationVersion: INTELLIGENCE_VERSION,
      impacted: {
        users: users.length,
        projects: projects.length,
        teams: teams.length,
        workspace: 1,
      },
    }),
  });

  return {
    users,
    projects,
    teams,
    workspace,
  };
}

export async function ensureCurrentIntelligence({ workspaceId, userId = null, role = "user" }) {
  await assertSchema();
  const workspace = await getWorkspaceIntelligence({ workspaceId });
  const currentUser = userId ? await getUserIntelligence({ workspaceId, userId }) : null;
  if (workspace && (!userId || currentUser)) {
    return { workspace, currentUser };
  }
  const bootstrapped = await bootstrapWorkspaceIntelligence({ workspaceId });
  return {
    workspace: bootstrapped.workspace,
    currentUser: userId ? await getUserIntelligence({ workspaceId, userId }) : null,
    role,
  };
}

export async function getUnifiedIntelligenceSnapshot({ workspaceId, userId = null, role = "user" }) {
  await ensureCurrentIntelligence({ workspaceId, userId, role });
  const [workspace, users, projects, teams, currentUser] = await Promise.all([
    getWorkspaceIntelligence({ workspaceId }),
    listUserIntelligence({ workspaceId }),
    listProjectIntelligence({ workspaceId }),
    listTeamIntelligence({ workspaceId }),
    userId ? getUserIntelligence({ workspaceId, userId }) : Promise.resolve(null),
  ]);

  return {
    workspace,
    users,
    projects,
    teams,
    currentUser,
    calculationVersion: INTELLIGENCE_VERSION,
  };
}

export default {
  evaluateAndPersistUser,
  evaluateAndPersistProject,
  evaluateAndPersistTeam,
  evaluateAndPersistWorkspace,
  bootstrapWorkspaceIntelligence,
  recalculateImpactedIntelligence,
  ensureCurrentIntelligence,
  getUnifiedIntelligenceSnapshot,
};
