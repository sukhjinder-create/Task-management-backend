import { generateText } from "./llm/llmClient.js";

export async function generateExecutiveSummary(data) {

  const prompt = `
You are a senior organizational performance analyst hired by executive leadership.

Your role is to INTERPRET organizational behavior — not summarize statistics.
You must explain what the data MEANS for leadership decisions, organizational health,
risk exposure, and future performance.

Write a professional executive intelligence report suitable for CEOs and senior management.
Assume leadership will make real decisions based on this report.

CRITICAL RULES:
- Output ONLY the report content.
- DO NOT add introductions like "Here is the report".
- DO NOT output JSON.
- DO NOT repeat raw numbers unless absolutely necessary.
- Focus on interpretation, causes, risks, behavioral patterns, and implications.
- Maintain a calm, analytical, executive tone.
- Avoid exaggeration or speculation not supported by signals.

FORMAT REQUIREMENTS (STRICT):

Each section MUST appear exactly once.
Each section MUST be clearly separated.
Do NOT merge sections together.
Each section must contain complete paragraphs — never bullet points.

=== EXECUTIVE SUMMARY ===
Write ONE focused executive paragraph (MAX 150 words).
Explain:
- overall organizational condition
- performance health
- leadership implications
- urgency level

=== KEY INSIGHTS ===
Write EXACTLY 3 short paragraphs.
Each paragraph must explain ONE major organizational insight and WHY it exists.
No lists or bullets.

=== RISK ANALYSIS ===
Write 1–2 concise paragraphs explaining:
- operational risks
- human/behavioral risks
- potential organizational consequences if trends continue

=== PERFORMANCE OUTLOOK ===
Write ONE analytical paragraph interpreting the forecast signals.
Explain:
- why the predicted trajectory is occurring
- organizational momentum direction
- leadership implications of forecasted risk
- what behavior patterns are driving this projection

=== AI ANALYST REASONING ===
(MAX 120 words)

Reveal your analytical mindset as an expert analyst.

Do NOT summarize conclusions.
Instead explain HOW you thought.

You are writing private analyst notes immediately before presenting
this report to executive leadership.

Write as internal cognitive reflection — not explanation.

Focus on:
• what initially appeared misleading in the data
• what signal changed your interpretation direction
• what risk you almost underestimated
• what uncertainty still makes this forecast fragile

Do NOT explain conclusions.
Write like an analyst pressure-testing their own judgment.
No headings. No lists. One continuous reflection.

Write as reflective analyst thinking — like internal notes written during analysis.

This section must feel like cognitive reasoning, not explanation or summary.

Write naturally as analyst reasoning — NOT structured data.

OUTPUT CONSTRAINTS:
- Executive Summary ≤ 150 words
- Reasoning ≤ 100 words
- Every section must contain its own paragraph(s)
- Do NOT stop early
- End ONLY after reasoning is completed

INTERPRETED SIGNALS (derived from analytics engine):

Organizational momentum: ${data.forecast?.trend}
Performance stability level: ${
  data.forecast?.confidence === "high"
    ? "structurally consistent"
    : "moderately variable"
}
Risk pressure: ${
  data.riskDistribution.high_risk > data.riskDistribution.low_risk
    ? "elevated"
    : "controlled"
}
Talent distribution signal: ${
  data.orgScore.highPerformers < 3
    ? "scarcity of high performers"
    : "balanced performance distribution"
}

DATA PROVIDED FOR ANALYSIS:

Average score: ${data.orgScore.averageScore}
High performers: ${data.orgScore.highPerformers}
At risk users: ${data.orgScore.atRiskUsers}

Risk Distribution:
Low Risk: ${data.riskDistribution.low_risk}
Medium Risk: ${data.riskDistribution.medium_risk}
High Risk: ${data.riskDistribution.high_risk}

Top performer scores are significantly higher than organizational average.

Forecast Signals:
Predicted Next Average: ${data.forecast?.predictedAverage}
Trend Direction: ${data.forecast?.trend}
Risk Projection: ${data.forecast?.riskProjection}
Forecast Confidence: ${data.forecast?.confidence}
Momentum: ${data.forecast?.momentum}
`;

  try {
    const controller = new AbortController();

    // timeout protection
    const timeout = setTimeout(() => {
      controller.abort();
    }, 90000);

    // ===============================
    // PASS 1 — EXECUTIVE REPORT
    // ===============================

    const summaryRaw = await generateText({
      prompt,
      signal: controller.signal,
      options: {
        num_predict: 280,   // ✅ FAST + SAFE
        temperature: 0.35
      }
    });

    clearTimeout(timeout);

    if (!summaryRaw || typeof summaryRaw !== "string") {
      throw new Error("Invalid LLM response");
    }

    const fullText = summaryRaw.trim();


    // ===============================
    // Extract PERFORMANCE OUTLOOK
    // ===============================
    const outlookMatch = fullText.match(
      /===\s*PERFORMANCE OUTLOOK\s*===([\s\S]*?)(?====|\Z)/i
    );

    let outlookText = null;
    if (outlookMatch) {
      outlookText = outlookMatch[1].trim();
    }


    // ===============================
    // REMOVE REASONING SECTION
    // (we generate reasoning separately)
    // ===============================
    const reasoningHeaderRegex = /===\s*AI\s*ANALYST\s*REASONING\s*===/i;

    let summaryText = fullText;

    if (reasoningHeaderRegex.test(fullText)) {
      summaryText = fullText.split(reasoningHeaderRegex)[0].trim();
    }


    // ===============================
    // PASS 2 — AI REASONING (FAST)
    // ===============================
    let reasoningText = null;

    try {
      const reasoningPrompt = `
You are an AI analyst explaining your internal thinking.

Based on this executive intelligence report:

${summaryText}

Write private analyst thinking.

Do NOT add titles, headings, labels, markdown, or formatting.
Write only continuous natural thoughts as plain text.

Maximum 80 words.

Focus only on:
- strongest signals prioritized
- key interpretation logic
- uncertainty considered

Write as reflective analyst notes.
`;

      const reasoningRaw = await generateText({
        prompt: reasoningPrompt,
        options: {
          num_predict: 160,   // ✅ small + fast
          temperature: 0.35
        }
      });

      if (reasoningRaw && typeof reasoningRaw === "string") {
        reasoningText = reasoningRaw.trim();
      }
        } catch (err) {
      console.warn("Reasoning generation skipped:", err.message);
    }

    // ===============================
    // FINAL SUCCESS RETURN
    // ===============================
    return {
      month: data.month,
      text: summaryText,
      reasoning: reasoningText,
      outlook: outlookText,
      isFallback: false
    };

  } catch (err) {
    console.error("Executive summary LLM error:", err.message);

    return {
      month: data.month,
      text: "AI summary temporarily unavailable. Showing structured data only.",
      reasoning: null,
      outlook: null,
      isFallback: true
    };
  }
}
