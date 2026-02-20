// src/integrations/integration.manager.js

import { getProvider } from "./integration.registry.js";
import "./providers/index.js";

/**
 * Integration Manager
 * Responsible for creating provider instances safely.
 */
class IntegrationManager {

  /**
   * Create provider instance
   */
  createProvider(providerName, config = {}) {
    const Provider = getProvider(providerName);

    if (!Provider) {
      throw new Error(`Integration provider not found: ${providerName}`);
    }

    return new Provider(config);
  }
}

export const integrationManager = new IntegrationManager();
