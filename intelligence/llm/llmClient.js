// Re-exports from the unified LLM client.
// All existing callers (autopilot, testing-agent, intelligence, browser-agent, etc.)
// continue to work without any changes.
export { generateText } from "../../services/llm.js";
