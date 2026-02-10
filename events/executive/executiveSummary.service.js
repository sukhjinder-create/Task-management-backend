import { buildExecutiveSummaryData } from "./executiveSummary.builder.js";
import { buildExecutivePrompt } from "./executiveSummary.prompt.js";
import { generateNarrative } from "../llm/llmClient.js";
import { saveExecutiveSummary } from "./executiveSummary.store.js";

/**
 * Generates executive summary for a workspace
 */
export async function generateExecutiveSummary({
  workspaceId,
  month,
  previousMonth,
}) {
  const data = await buildExecutiveSummaryData({
    workspaceId,
    month,
    previousMonth,
  });

  if (!data) return;

  const prompt = buildExecutivePrompt(data);
  const summary = await generateNarrative(prompt);

  await saveExecutiveSummary({
    workspaceId,
    period: month,
    summary,
    sourceData: data,
  });
}
