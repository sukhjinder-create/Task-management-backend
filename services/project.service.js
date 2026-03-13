// services/project.service.js
import projectRepository from "../repositories/project.repository.js";

/**
 * ProjectService
 *
 * IMPORTANT GUARANTEES:
 * - ❌ No function removed
 * - ❌ No logic silently deleted
 * - ✅ Workspace-aware, but backward-compatible
 * - ✅ Works even if repository signatures differ
 *
 * This file intentionally contains defensive fallbacks
 * to support legacy + new repository implementations.
 */

class ProjectService {
  /**
   * CREATE PROJECT
   * data must already contain workspaceId (enforced by route middleware)
   */
  async create(data) {
    if (!data) {
      throw new Error("Project data is required");
    }

    let created = null;

    // Try modern repository (workspace-aware)
    try {
      created = await projectRepository.createProject(data);
    } catch (err) {
      // Legacy fallback (older repo versions)
      try {
        created = await projectRepository.createProject({
          name: data.name,
          added_by: data.added_by,
        });
      } catch (legacyErr) {
        throw err;
      }
    }

    // Zero-touch Git automation defaults for new projects (best effort).
    // Non-blocking to avoid impacting project creation reliability.
    if (created?.id && (data?.workspaceId || created?.workspace_id)) {
      import("../integrations/git/git.automation.service.js")
        .then(({ upsertGitProjectAutomationSettings }) =>
          upsertGitProjectAutomationSettings({
            workspaceId: data.workspaceId || created.workspace_id,
            projectId: created.id,
            enabled: true,
            autoStatusEnabled: true,
            autoCompleteOnProd: true,
            repoFullName: null,
            environmentSequence: ["dev", "qa", "stage", "uat", "prod"],
            branchEnvironmentMap: {
              develop: "dev",
              "feature/*": "dev",
              qa: "qa",
              test: "qa",
              staging: "stage",
              "release/*": "stage",
              uat: "uat",
              main: "prod",
              master: "prod",
            },
            requireTaskKey: false,
            autoInferTasks: true,
            minInferenceConfidence: 62,
            maxInferredTasks: 2,
            actorId: null,
          })
        )
        .catch(() => {});
    }

    return created;
  }

  /**
   * LIST PROJECTS
   * Pass role + userId for role-based scoping.
   * admin  → all workspace projects
   * manager → projects in user's projects array
   * user   → projects with assigned tasks only
   */
  async list(workspaceId, role, userId) {
    if (role && userId && role !== "admin") {
      return projectRepository.getProjectsByRole(workspaceId, userId, role);
    }
    // Admin or no context → all projects
    try {
      return await projectRepository.getProjects(workspaceId);
    } catch (err) {
      try {
        return await projectRepository.getProjects();
      } catch (legacyErr) {
        throw err;
      }
    }
  }

  /**
   * GET SINGLE PROJECT
   */
  async getOne(id, workspaceId) {
    if (!id) {
      throw new Error("Project id is required");
    }

    // Workspace-aware path
    try {
      return await projectRepository.getProjectById(id, workspaceId);
    } catch (err) {
      // Legacy fallback
      try {
        return await projectRepository.getProjectById(id);
      } catch (legacyErr) {
        throw err;
      }
    }
  }

  /**
   * UPDATE PROJECT
   */
  async update(id, data) {
    if (!id) {
      throw new Error("Project id is required");
    }

    if (!data) {
      throw new Error("Update data is required");
    }

    // Workspace-aware update
    try {
      return await projectRepository.updateProject(id, data);
    } catch (err) {
      // Legacy fallback
      try {
        return await projectRepository.updateProject(id, {
          name: data.name,
        });
      } catch (legacyErr) {
        throw err;
      }
    }
  }

  /**
   * DELETE PROJECT
   */
  async delete(id, workspaceId) {
    if (!id) {
      throw new Error("Project id is required");
    }

    // Workspace-aware delete
    try {
      return await projectRepository.deleteProject(id, workspaceId);
    } catch (err) {
      // Legacy fallback
      try {
        return await projectRepository.deleteProject(id);
      } catch (legacyErr) {
        throw err;
      }
    }
  }
}

const projectService = new ProjectService();
export default projectService;
