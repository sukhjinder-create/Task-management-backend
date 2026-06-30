const providers = new Map();

export function registerContextProvider(provider) {
  if (!provider?.key || typeof provider.load !== "function") {
    throw new TypeError("Context provider requires key and load()");
  }
  if (providers.has(provider.key)) return false;
  providers.set(provider.key, {
    priority: 0,
    supports: () => true,
    ...provider,
  });
  return true;
}

export function listContextProviders() {
  return Array.from(providers.values())
    .sort((a, b) => b.priority - a.priority)
    .map(({ key, description, priority }) => ({ key, description, priority }));
}

export function getApplicableContextProviders(input) {
  return Array.from(providers.values())
    .filter((provider) => {
      try {
        return provider.supports(input);
      } catch {
        return false;
      }
    })
    .sort((a, b) => b.priority - a.priority);
}

export function clearContextProvidersForTests() {
  providers.clear();
}
