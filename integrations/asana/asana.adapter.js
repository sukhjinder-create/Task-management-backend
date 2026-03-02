/**
 * ASANA ADAPTER
 *
 * IMPORTANT:
 * This DOES NOT contain business logic.
 * It only delegates to existing services.
 */

import {
  fetchAsanaProjects,
  fetchAsanaProjectTasks,
  updateAsanaTaskStatus
} from "./asana.viewer.service.js";

import {
  migrateAsanaProject
} from "./asana.migration.service.js";

export async function listProjects(workspaceId) {
  return fetchAsanaProjects(workspaceId);
}

export async function listTasks(workspaceId, projectId, options) {
  return fetchAsanaProjectTasks(workspaceId, projectId, options);
}

export async function migrateProject(params) {
  return migrateAsanaProject(params);
}

export async function updateTaskStatus(workspaceId, taskId, completed) {
  return updateAsanaTaskStatus(workspaceId, taskId, completed);
}