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
  projectId
) {
  const token = await getToken(workspaceId);

  const headers = {
    Authorization: `Bearer ${token}`,
  };

  let offset = null;
  const allTasks = [];
  console.log("PROJECT ID RECEIVED:", projectId);
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

  return allTasks;
}
