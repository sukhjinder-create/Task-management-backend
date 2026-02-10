/**
 * Converts evidence into a fixed explanation outline.
 * LLM is NOT allowed to change structure.
 */

export function buildUserExplanationOutline(evidence) {
  return {
    sections: [
      {
        title: "What contributed positively",
        bullets: evidence.positiveFactors.map(
          f => `${f.fact} (${f.impact})`
        ),
      },
      {
        title: "What reduced the score",
        bullets: evidence.negativeFactors.map(
          f => `${f.fact} (${f.impact})`
        ),
      },
      {
        title: "What to focus on next month",
        bullets: evidence.improvementLevers.map(
          i => `${i.action} (${i.expectedImpact})`
        ),
      },
    ],
  };
}
