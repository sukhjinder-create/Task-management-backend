export function buildExecutivePrompt(data) {
  return `
You are writing a monthly executive performance summary.

STRICT RULES:
- Do NOT add facts
- Do NOT speculate
- Do NOT include individual names
- Do NOT include implementation details

FACTS:
${JSON.stringify(data, null, 2)}

STRUCTURE (MANDATORY):
1. Overall performance trend (1 paragraph)
2. Risk outlook (1 paragraph)
3. AI coaching impact (1 paragraph)
4. Leadership focus areas (bullet points)

Tone:
- Executive
- Concise
- Neutral
- Data-driven

Length:
- Max 300 words
`;
}
