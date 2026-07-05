import axios from "axios";
import { generateText } from "../../services/llm.js";
import { envBool } from "../../config/environment.js";

const AI_URL = process.env.AI_SERVICE_URL;
const AI_SECRET = process.env.AI_SERVICE_SECRET;

/**
 * Generates a natural-language narrative.
 *
 * UNIFIED path (AI_PLATFORM_UNIFIED=true): routes through the ONE AI Platform via
 * generateText (single client → negotiation/safety/prompt/runtime/telemetry/cost).
 * LEGACY path (default): HTTP → ai-task, preserved for rollback. If the LLM/service
 * fails, callers already handle the throw and continue.
 * @param {string} prompt
 * @param {{capability?:string, workspaceId?:string}} [opts]
 */
export async function generateNarrative(prompt, { capability = "llm_explanation", workspaceId = null } = {}) {
  if (envBool("AI_PLATFORM_UNIFIED", false)) {
    return generateText({ prompt, capability, workspaceId, maxTokens: 600 });
  }

  // Legacy (rollback): call the ai-task service over HTTP.
  if (!AI_URL || !AI_SECRET) {
    throw new Error("AI service not configured");
  }
  const { data } = await axios.post(
    AI_URL,
    { prompt },
    { headers: { Authorization: `Bearer ${AI_SECRET}` } }
  );
  return data?.text || "";
}
