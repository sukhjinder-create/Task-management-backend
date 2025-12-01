import projectRepository from "../repositories/project.repository.js";

class ProjectService {
  create(data) {
    return projectRepository.createProject(data);
  }

  list() {
    return projectRepository.getProjects();
  }

  getOne(id) {
    return projectRepository.getProjectById(id);
  }

  update(id, data) {
    return projectRepository.updateProject(id, data);
  }

  delete(id) {
    return projectRepository.deleteProject(id);
  }
}

const projectService = new ProjectService();
export default projectService;
