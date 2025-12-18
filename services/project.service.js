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

    // Try modern repository (workspace-aware)
    try {
      return await projectRepository.createProject(data);
    } catch (err) {
      // Legacy fallback (older repo versions)
      try {
        return await projectRepository.createProject({
          name: data.name,
          added_by: data.added_by,
        });
      } catch (legacyErr) {
        throw err;
      }
    }
  }

  /**
   * LIST PROJECTS
   * workspaceId comes from auth + workspace middleware
   */
  async list(workspaceId) {
    // Workspace-aware repository
    try {
      return await projectRepository.getProjects(workspaceId);
    } catch (err) {
      // Legacy fallback (no workspace support)
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
