// src/integrations/integration.registry.js

/**
 * Central registry of all integration providers.
 * Providers register themselves here.
 */

const providers = new Map();

/**
 * Register a provider
 */
export function registerProvider(name, providerClass) {
  if (!name || !providerClass) {
    throw new Error("Invalid provider registration");
  }

  providers.set(name, providerClass);
}

/**
 * Get provider by name
 */
export function getProvider(name) {
  return providers.get(name);
}

/**
 * List available providers
 */
export function listProviders() {
  return Array.from(providers.keys());
}