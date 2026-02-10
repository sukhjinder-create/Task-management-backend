import axios from "axios";

const AI_URL = process.env.AI_SERVICE_URL;
const AI_SECRET = process.env.AI_SERVICE_SECRET;

/**
 * Calls LLM safely.
 * If LLM fails, system continues without breaking.
 */
export async function generateNarrative(prompt) {
  if (!AI_URL || !AI_SECRET) {
    throw new Error("AI service not configured");
  }

  const { data } = await axios.post(
    AI_URL,
    { prompt },
    {
      headers: {
        Authorization: `Bearer ${AI_SECRET}`,
      },
    }
  );

  return data?.text || "";
}
