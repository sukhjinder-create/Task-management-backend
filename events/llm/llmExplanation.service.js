import pool from "../../db.js";
import { generateNarrative } from "./llmClient.js";
import { saveNarrative } from "./llmNarrative.store.js";
import { buildUserMonthlyPrompt } from "./llmPrompt.builder.js";

/**
 * Generates natural-language explanation for a user’s monthly score
 */
export async function generateUserMonthlyExplanation({
  workspaceId,
  userId,
  month,
}) {
  const { rows } = await pool.query(
    `
    SELECT score, breakdown, reasoning, improvements
    FROM workspace_monthly_scores
    WHERE workspace_id = $1
      AND user_id = $2
      AND month = $3
    `,
    [workspaceId, userId, month]
  );

  if (!rows.length) return;

  const data = rows[0];

  const prompt = buildUserMonthlyPrompt(data);
  const narrative = await generateNarrative(prompt);

  await saveNarrative({
    workspaceId,
    scope: "user",
    subjectId: userId,
    period: month,
    narrative,
    sourceData: data,
  });
}
