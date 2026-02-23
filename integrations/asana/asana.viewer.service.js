import axios from "axios";
import pool from "../../db.js";

/**
 * Get Asana access token for workspace
 */
async function getToken(workspaceId) {
    console.log("VIEWER workspaceId:", workspaceId);
  const result = await pool.query(
    `
    SELECT config
    FROM workspace_integrations
    WHERE workspace_id = $1
      AND provider = 'asana'
    LIMIT 1
  `,
    [workspaceId]
  );
  console.log("Integration rows found:", result.rows.length);

  if (!result.rows.length) {
    throw new Error("Asana not connected for workspace");
  }

  const config = result.rows[0].config ?? {};
  
  const accessToken = config.access_token;

if (!accessToken) {
  console.error("Invalid Asana config:", config);
  throw new Error("Asana access token missing");
}

return accessToken;
}

/**
 * Fetch Asana projects (LIVE)
 */
export async function fetchAsanaProjects(workspaceId) {
  const token = await getToken(workspaceId);

  const headers = {
    Authorization: `Bearer ${token}`,
  };

  const ws = await axios.get(
    "https://app.asana.com/api/1.0/workspaces",
    { headers }
  );

  const asanaWorkspace = ws.data.data[0];

  const projects = await axios.get(
    "https://app.asana.com/api/1.0/projects",
    {
      headers,
      params: {
        workspace: asanaWorkspace.gid,
        archived: false,
        opt_fields: "gid,name",
      },
    }
  );

  return projects.data.data;
}

/**
 * Fetch tasks for a project (LIVE)
 */
export async function fetchAsanaProjectTasks(
  workspaceId,
  projectId,
  { page = 1, limit = 25, search = "" }
) {
  const token = await getToken(workspaceId);

  const headers = {
    Authorization: `Bearer ${token}`,
  };

  let offset = null;
  let allTasks = [];

  // 🔥 walk ALL asana pages
  do {
    const res = await axios.get(
      `https://app.asana.com/api/1.0/projects/${projectId}/tasks`,
      {
        headers,
        params: {
          limit: 100,
          offset,
          opt_fields:
            "gid,name,completed,assignee,modified_at",
        },
      }
    );

    allTasks.push(...res.data.data);

    offset = res.data?.next_page?.offset || null;

  } while (offset);

  // ✅ GLOBAL SEARCH (after collecting all tasks)
  if (search) {
    const q = search.toLowerCase();

    allTasks = allTasks.filter(t =>
      t.name?.toLowerCase().includes(q)
    );
  }

  // ✅ REAL PAGE CALCULATION
  const start = (page - 1) * limit;
  const paginated = allTasks.slice(start, start + limit);

  return {
    data: paginated,
    total: allTasks.length,
    hasMore: start + limit < allTasks.length,
    totalPages: Math.ceil(allTasks.length / limit),
    currentPage: page,
  };
}

/**
 * Update Asana task completion status
 */
export async function updateAsanaTaskStatus(
  workspaceId,
  taskId,
  completed
) {
  const token = await getToken(workspaceId);

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  await axios.put(
    `https://app.asana.com/api/1.0/tasks/${taskId}`,
    {
      data: {
        completed,
      },
    },
    { headers }
  );

  return { success: true };
}
