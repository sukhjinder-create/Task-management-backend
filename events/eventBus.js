// Very simple observer bus
// No business logic here

const observers = [];

export function registerObserver(observerFn) {
  observers.push(observerFn);
}

export async function publishEvent(event) {
  console.log("📡 EventBus received:", event.eventType);
  for (const observer of observers) {
    try {
      await observer(event);
    } catch (err) {
      console.error("[EventBus] Observer failed:", err);
    }
  }
}
