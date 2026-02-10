/**
 * Builds a user-facing coaching message
 * without LLM
 */
export function buildCoachingMessage({
  action,
  reason,
  expectedImpact,
  evidence,
}) {
  const facts = evidence.map(e => e.fact).join("; ");

  return `
Action to focus on:
${action}

Why this matters:
${reason}

What we observed:
${facts}

Expected impact:
${expectedImpact}
`.trim();
}
