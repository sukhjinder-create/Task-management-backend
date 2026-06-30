// Process-local delivery bus. Durable delivery is provided by the event-store
// and adaptive-queue observers; this module intentionally owns no business logic.

const observers = new Map();

export function registerObserver(observerFn, options = {}) {
  if (typeof observerFn !== "function") {
    throw new TypeError("Event observer must be a function");
  }

  const name = options.name || observerFn.name || `observer-${observers.size + 1}`;
  if (observers.has(name)) return false;

  observers.set(name, {
    name,
    priority: Number(options.priority || 0),
    observerFn,
  });
  return true;
}

export function unregisterObserver(name) {
  return observers.delete(name);
}

export function listObservers() {
  return Array.from(observers.values())
    .sort((a, b) => b.priority - a.priority)
    .map(({ name, priority }) => ({ name, priority }));
}

export async function publishEvent(event) {
  const ordered = Array.from(observers.values()).sort((a, b) => b.priority - a.priority);
  const failures = [];

  for (const observer of ordered) {
    try {
      await observer.observerFn(event);
    } catch (error) {
      failures.push({ observer: observer.name, error: error?.message || "Unknown observer error" });
      console.error(`[EventBus] ${observer.name} failed:`, error?.message || error);
    }
  }

  return { delivered: ordered.length - failures.length, failures };
}
