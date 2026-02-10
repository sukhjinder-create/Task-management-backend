/**
 * Deterministic fallback explanation (no LLM).
 */

export function generateFallbackExplanation(outline) {
  return outline.sections
    .map(
      s =>
        `${s.title}:\n- ` + s.bullets.join("\n- ")
    )
    .join("\n\n");
}
