console.log("Fetching YouTrack projects...");

import youtrackAdapter from "./youtrack.adapter.js";

export async function fetchYouTrackProjects(workspaceId) {
    console.log("VIEWER workspaceId:", workspaceId);
  return await youtrackAdapter.listProjects(workspaceId);
}

export async function fetchYouTrackProjectTasks(
  workspaceId,
  projectId,
  options = {}
) {
  return await youtrackAdapter.listTasksPaginated(workspaceId, projectId, options);
}