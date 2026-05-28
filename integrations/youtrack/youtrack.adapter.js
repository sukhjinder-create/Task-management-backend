import axios from "axios";
import pool from "../../db.js";

/*
  YouTrack Adapter
  ----------------
  SAFE:
  - Does NOT modify existing integrations
  - Uses same workspace_integrations table
*/

async function getConfig(workspaceId) {
  const res = await pool.query(
    `
    SELECT config
    FROM workspace_integrations
    WHERE workspace_id=$1
      AND provider='youtrack'
    LIMIT 1
    `,
    [workspaceId]
  );

  if (!res.rows.length) {
    throw new Error("YouTrack not connected");
  }

  return res.rows[0].config;
}

async function connectWorkspace(workspaceId, baseUrl, token) {
  const base_url = baseUrl?.trim();

  if (!base_url || !token) {
    throw new Error("base_url and token are required");
  }

  let cleanUrl = base_url.replace(/\/$/, "");

  // Preserve the existing URL normalization behavior.
  if (!cleanUrl.endsWith("/youtrack")) {
    cleanUrl = `${cleanUrl}/youtrack`;
  }

  await axios.get(`${cleanUrl}/api/users/me`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  await pool.query(
    `
    INSERT INTO workspace_integrations
      (workspace_id, provider, config)
    VALUES ($1,'youtrack',$2)
    ON CONFLICT (workspace_id, provider)
    DO UPDATE SET
      config = EXCLUDED.config,
      updated_at = NOW()
    `,
    [
      workspaceId,
      {
        base_url: cleanUrl,
        token,
      },
    ]
  );

  return {
    success: true,
    provider: "youtrack",
  };
}

async function listProjects(workspaceId) {
  const config = await getConfig(workspaceId);
  const { base_url, token } = config;

  // Pull issues instead of projects because this permission is usually allowed.
  const res = await axios.get(`${base_url}/api/issues`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    params: {
      fields: "project(id,shortName,name)",
      $top: 200,
    },
  });

  const projectMap = new Map();

  for (const issue of res.data || []) {
    const project = issue.project;
    if (!project) continue;

    projectMap.set(project.shortName, {
      id: project.id,
      key: project.shortName,
      shortName: project.shortName,
      name: project.name,
    });
  }

  return Array.from(projectMap.values());
}

function getFieldValue(issue, fieldName) {
  return (issue.customFields || []).find((field) => field.name === fieldName)
    ?.value;
}

function mapIssue(issue) {
  const assigneeValue = getFieldValue(issue, "Assignee");
  const stateValue = getFieldValue(issue, "State");

  const assignee = assigneeValue?.fullName || assigneeValue?.login || "-";
  const state = stateValue?.name || "Open";

  return {
    id: issue.idReadable,
    name: issue.summary,
    title: issue.summary,
    completed: !!issue.resolved,
    status: state,
    assignee,
    modified_at: issue.updated,
    lastModified: issue.updated,
    created: issue.created,
    updated: issue.updated,
    description: issue.description || "",
    createdAt: issue.created,
    updatedAt: issue.updated,
    provider: "youtrack",
  };
}

function formatYouTrackDateTime(value) {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const pad = (part) => String(part).padStart(2, "0");
  const day = [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
  ].join("-");

  return `${day}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function buildIssueQuery(projectKey, { search = "", updatedAfter = null } = {}) {
  const parts = [`project: {${projectKey}}`];
  const updatedAfterQuery = formatYouTrackDateTime(updatedAfter);

  if (updatedAfterQuery) {
    parts.push(`updated: ${updatedAfterQuery} .. *`);
  }

  if (search) {
    parts.push(search);
  }

  return parts.join(" ");
}

async function fetchIssuesByQuery(config, query) {
  const { base_url, token } = config;
  const pageSize = 100;
  let skip = 0;
  const allIssues = [];

  while (true) {
    const res = await axios.get(`${base_url}/api/issues`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      params: {
        query,
        fields:
          "id,idReadable,summary,resolved,description,created,updated,customFields(name,value(name,fullName,login))",
        $top: pageSize,
        $skip: skip,
      },
    });

    const batch = res.data || [];
    allIssues.push(...batch);

    if (batch.length < pageSize) break;
    skip += pageSize;
  }

  return allIssues;
}

async function listTasksPaginated(
  workspaceId,
  projectKey,
  { page = 1, limit = 25, search = "" } = {}
) {
  const config = await getConfig(workspaceId);
  const { base_url, token } = config;
  const skip = (page - 1) * limit;
  const query = buildIssueQuery(projectKey, { search });

  const res = await axios.get(`${base_url}/api/issues`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    params: {
      query,
      fields:
        "id,idReadable,summary,resolved,description,created,updated,customFields(name,value(name,fullName,login))",
      $top: limit + 1,
      $skip: skip,
    },
  });

  const raw = res.data || [];
  const hasMore = raw.length > limit;
  const issues = hasMore ? raw.slice(0, limit) : raw;

  return { data: issues.map(mapIssue), hasMore, page };
}

async function listTasks(workspaceId, projectKey, { updatedAfter = null } = {}) {
  const config = await getConfig(workspaceId);
  const incrementalQuery = buildIssueQuery(projectKey, { updatedAfter });
  let issues;

  try {
    issues = await fetchIssuesByQuery(config, incrementalQuery);
  } catch (err) {
    if (!updatedAfter) {
      throw err;
    }

    console.warn(
      `YouTrack incremental query failed for ${projectKey}; falling back to full fetch`
    );
    issues = await fetchIssuesByQuery(config, buildIssueQuery(projectKey));
  }

  return issues.map(mapIssue);
}

async function getTask(workspaceId, issueId) {
  const config = await getConfig(workspaceId);
  const { base_url, token } = config;

  const res = await axios.get(
    `${base_url}/api/issues/${encodeURIComponent(issueId)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      params: {
        fields:
          "id,idReadable,summary,resolved,description,created,updated,project(id,shortName,name),customFields(name,value(name,fullName,login))",
      },
    }
  );

  const issue = mapIssue(res.data);

  return {
    ...issue,
    projectName: res.data?.project?.name || null,
    projectKey: res.data?.project?.shortName || null,
  };
}

async function updateTaskStatus(workspaceId, issueId, completed) {
  const config = await getConfig(workspaceId);
  const { base_url, token } = config;

  const issueRes = await axios.get(`${base_url}/api/issues/${issueId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    params: {
      fields: "customFields(id,name,value(name,isResolved),project(id))",
    },
  });

  const issue = issueRes.data;
  const stateField = (issue.customFields || []).find(
    (field) => field.name === "State"
  );

  if (!stateField) {
    throw new Error("State field not found");
  }

  const bundleRes = await axios.get(
    `${base_url}/api/admin/customFieldSettings/bundles/state`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      params: {
        fields: "values(name,isResolved)",
      },
    }
  );

  const bundles = bundleRes.data;

  if (!Array.isArray(bundles) || bundles.length === 0) {
    throw new Error("No state bundles returned from YouTrack");
  }

  const states = bundles[0].values;

  if (!Array.isArray(states)) {
    throw new Error("State bundle values missing");
  }

  const targetState = states.find(
    (state) => state.isResolved === Boolean(completed)
  );

  if (!targetState) {
    throw new Error("No valid state found in workflow");
  }

  await axios.post(
    `${base_url}/api/issues/${issueId}/fields/${stateField.id}`,
    {
      value: {
        name: targetState.name,
        $type: "StateBundleElement",
      },
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    }
  );

  return { success: true };
}

export default {
  provider: "youtrack",
  connectWorkspace,
  listProjects,
  getTask,
  listTasks,
  listTasksPaginated,
  updateTaskStatus,
};
