
import { generateText } from "../intelligence/llm/llmClient.js";
import { buildAIContext } from "./ai.context.builder.js";

/**
 * Strategic Intelligence Query Service
 * Analyzes operational data and provides executive-level insights
 *
 * NOT for casual chat - for decision support
 */
export async function runAIIntelligenceQuery({
  workspaceId,
  scope,
  entityId,
  question
}) {

  try {
    // 1️⃣ Build structured context from single source of truth
    const context = await buildAIContext({
      workspaceId,
      scope,
      entityId
    });

    // 2️⃣ Build prompt
    const contextJson = JSON.stringify(context, null, 2);

    const prompt = `
You are Strategic Intelligence inside an enterprise operations platform.

This is NOT casual chat.
This is operational analytics.

User Question:
"${question}"

Scope: ${scope}

Structured Context:
${contextJson}

Instructions:
- Be precise.
- Identify operational risks.
- Identify execution delays.
- Mention root causes.
- Highlight leadership concerns.
- If insufficient data, say so.
- Do NOT hallucinate.
- Professional executive tone.
- Max 180 words.
`;

    // 3️⃣ Log prompt stats for debugging
    console.log(`🧠 AI Intelligence Query:
  - Scope: ${scope}
  - EntityId: ${entityId || "N/A"}
  - Question length: ${question.length} chars
  - Context size: ${contextJson.length} chars
  - Total prompt size: ${prompt.length} chars`);

    // 4️⃣ Check if prompt is too large (Ollama context limit)
    if (prompt.length > 50000) {
      console.warn(`⚠️  Prompt size (${prompt.length}) exceeds safe limit. Truncating context...`);
      throw new Error("Context too large. Please narrow your query scope.");
    }

    // 5️⃣ Generate answer
    const answer = await generateText({ prompt });

    return answer.trim();

  } catch (error) {
    console.error("❌ AI Intelligence Query Failed:", error.message);
    throw error;
  }
}