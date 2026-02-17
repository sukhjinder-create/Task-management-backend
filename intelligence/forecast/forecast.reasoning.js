import { generateText } from "../llm/llmClient.js";

export async function generateForecastReasoning({
  history,
  forecast
}) {

  const prompt = `
You are an Organizational Intelligence Analyst working inside a workplace performance analytics system.

IMPORTANT CONTEXT:
This data represents EMPLOYEE and ORGANIZATIONAL performance scores inside a company workspace.
This is NOT sports data.
This is NOT athlete performance.
Never reference athletes, competitions, games, or sports.

Your task:
Explain WHY the forecast engine produced this prediction using organizational behavior reasoning.

Write a professional internal analyst explanation.

Limit to MAX 120 words.

Explain:

• what historical performance pattern was detected
• how the trend direction was inferred
• what signals influenced prediction confidence
• what organizational behavior this suggests
• risks leadership should understand

Use workplace language:
employees, teams, productivity, engagement, performance stability, organizational momentum.

DATA:

Historical scores:
${JSON.stringify(history)}

Forecast result:
Prediction: ${forecast.prediction}
Trend: ${forecast.trend}
Confidence: ${forecast.confidence}

Output ONLY the reasoning paragraph.
No headings.
No JSON.
No introductions.
`;

  try {
    const raw = await generateText({
      prompt,
      options: {
        num_predict: 180,
        temperature: 0.4
      }
    });

    if (!raw || typeof raw !== "string") {
      throw new Error("Invalid reasoning response");
    }

    return raw.trim();

  } catch (err) {
    console.error("Forecast reasoning error:", err.message);
    return "Forecast reasoning unavailable.";
  }
}
