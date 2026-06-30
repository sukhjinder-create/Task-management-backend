import { enqueueAdaptiveEvent } from "./eventQueue.repository.js";

export async function adaptiveEventQueueObserver(event) {
  await enqueueAdaptiveEvent(event);
}
