// src/integrations/providers/base.provider.js

/**
 * Base Integration Provider
 * All providers must extend this class.
 */
export default class BaseProvider {

  constructor(config = {}) {
    this.config = config;
  }

  async connect() {
    throw new Error("connect() not implemented");
  }

  async validate() {
    throw new Error("validate() not implemented");
  }

  async fetchProjects() {
    throw new Error("fetchProjects() not implemented");
  }

  async fetchTasks() {
    throw new Error("fetchTasks() not implemented");
  }

  async fetchUsers() {
    throw new Error("fetchUsers() not implemented");
  }

  async fetchActivity() {
    throw new Error("fetchActivity() not implemented");
  }

  async disconnect() {
    return true;
  }
}
