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

  // ✅ normalize naming (CRITICAL FIX)
  const base_url = baseUrl?.trim();

  if (!base_url || !token) {
    throw new Error("base_url and token are required");
  }

  // remove trailing slash (prevents API bugs)
  let cleanUrl = base_url.replace(/\/$/, "");

// ✅ auto-fix YouTrack cloud URL
if (!cleanUrl.endsWith("/youtrack")) {
  cleanUrl = cleanUrl + "/youtrack";
}

  // ✅ verify connection with YouTrack
  await axios.get(`${cleanUrl}/api/users/me`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  // ✅ store integration config
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

/* ===============================
   LIST PROJECTS
=============================== */
async function listProjects(workspaceId) {
  console.log("🔥 YOUTRACK ADAPTER listProjects CALLED", workspaceId);

  const config = await getConfig(workspaceId);
  const { base_url, token } = config;

  // Pull issues instead of projects (always allowed)
  const res = await axios.get(
    `${base_url}/api/issues`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      params: {
        fields: "project(id,shortName,name)",
        $top: 200
      },
    }
  );

  // extract unique projects
  const projectMap = new Map();

  for (const issue of res.data) {
    const p = issue.project;
    if (!p) continue;

    projectMap.set(p.shortName, {
      id: p.id,
      key: p.shortName,
      shortName: p.shortName,
      name: p.name,
    });
  }

  const projects = Array.from(projectMap.values());

  console.log("✅ Derived projects:", projects.length);

  return projects;
}

/* ===============================
   SHARED ISSUE MAPPER
=============================== */
function mapIssue(issue) {
  let assignee = "—";
  let state = "Open";
  for (const field of issue.customFields || []) {
    if (field.name === "Assignee" && field.value) {
      assignee = field.value.fullName || field.value.login || "—";
    }
    if (field.name === "State" && field.value) {
      state = field.value.name || "Open";
    }
  }
  return {
    id: issue.idReadable,
    name: issue.summary,
    title: issue.summary,
    completed: !!issue.resolved,
    status: state,
    assignee,
    modified_at: issue.updated,
    lastModified: issue.updated,
    description: issue.description || "",
    createdAt: issue.created,
    updatedAt: issue.updated,
    provider: "youtrack",
  };
}

/* ===============================
   LIST TASKS — paginated viewer
=============================== */
async function listTasksPaginated(workspaceId, projectKey, { page = 1, limit = 25, search = "" } = {}) {
  const config = await getConfig(workspaceId);
  const { base_url, token } = config;

  const skip = (page - 1) * limit;
  const query = search
    ? `project: {${projectKey}} ${search}`
    : `project: {${projectKey}}`;

  const res = await axios.get(`${base_url}/api/issues`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    params: {
      query,
      fields: "id,idReadable,summary,resolved,description,created,updated,customFields(name,value(name,fullName,login))",
      $top: limit + 1, // fetch one extra to detect hasMore
      $skip: skip,
    },
  });

  const raw = res.data || [];
  const hasMore = raw.length > limit;
  const issues = hasMore ? raw.slice(0, limit) : raw;

  return { data: issues.map(mapIssue), hasMore, page };
}

/* ===============================
   LIST TASKS — full fetch for migration
=============================== */
async function listTasks(workspaceId, projectKey) {
  const config = await getConfig(workspaceId);
  const { base_url, token } = config;

  const pageSize = 100;
  let skip = 0;
  let allIssues = [];

  while (true) {
    const res = await axios.get(
      `${base_url}/api/issues`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        params: {
          query: `project: {${projectKey}}`,
          fields:
            "id,idReadable,summary,resolved,description,created,updated,customFields(name,value(name,fullName,login))",
          $top: pageSize,
          $skip: skip,
        },
      }
    );

    const batch = res.data || [];
    allIssues.push(...batch);

    if (batch.length < pageSize) break;
    skip += pageSize;
  }

  return allIssues.map(issue => {

  let assignee = "—";
  let state = "Open";

  for (const field of issue.customFields || []) {

    // ✅ ASSIGNEE
    if (field.name === "Assignee" && field.value) {
      assignee =
        field.value.fullName ||
        field.value.login ||
        "—";
    }

    // ✅ STATUS / STATE
    if (field.name === "State" && field.value) {
      state = field.value.name || "Open";
    }
  }

  return {
    id: issue.idReadable,
    name: issue.summary,
    title: issue.summary,

    completed: !!issue.resolved,
    status: state,
    assignee,

    // ✅ FIXED timestamp normalization
    modified_at: issue.updated,
    lastModified: issue.updated,

    description: issue.description || "",

    createdAt: issue.created,
    updatedAt: issue.updated,

    provider: "youtrack"
  };
});
}

async function updateTaskStatus(workspaceId, issueId, completed) {

  const config = await getConfig(workspaceId);
  const { base_url, token } = config;

  // 1️⃣ Fetch issue with full state bundle
  const issueRes = await axios.get(
    `${base_url}/api/issues/${issueId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      params: {
        fields: "customFields(id,name,value(name,isResolved),project(id))"
      }
    }
  );

  const issue = issueRes.data;

  const stateField = issue.customFields
    .find(f => f.name === "State");

  if (!stateField) {
    throw new Error("State field not found");
  }

  // 2️⃣ Fetch full state bundle for this project
  const bundleRes = await axios.get(
    `${base_url}/api/admin/customFieldSettings/bundles/state`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      params: {
        fields: "values(name,isResolved)"
      }
    }
  );

  // YouTrack returns array of bundles
const bundles = bundleRes.data;

if (!Array.isArray(bundles) || bundles.length === 0) {
  throw new Error("No state bundles returned from YouTrack");
}

// pick first bundle (safe default — most setups have one)
const states = bundles[0].values;

if (!Array.isArray(states)) {
  throw new Error("State bundle values missing");
}

console.log("STATE BUNDLES:", JSON.stringify(bundleRes.data, null, 2));

  // 3️⃣ Pick correct state dynamically
  let targetState;

  if (completed) {
    targetState = states.find(s => s.isResolved === true);
  } else {
    targetState = states.find(s => s.isResolved === false);
  }

  if (!targetState) {
    throw new Error("No valid state found in workflow");
  }

  // 4️⃣ Update issue state properly (CORRECT ENDPOINT)

await axios.post(
  `${base_url}/api/issues/${issueId}/fields/${stateField.id}`,
  {
    value: {
      name: targetState.name,
      $type: "StateBundleElement"
    }
  },
  {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json"
    }
  }
);

  return { success: true };
}

export default {
  provider: "youtrack",
  connectWorkspace,
  listProjects,
  listTasks,
  listTasksPaginated,
  updateTaskStatus
};