export async function generateMonthlyCoaching({
  workspaceId,
  userId,
  month,
}) {
  const { rows } = await pool.query(
    `
    SELECT reasoning
    FROM workspace_monthly_scores
    WHERE workspace_id = $1
      AND user_id = $2
      AND month = $3
    `,
    [workspaceId, userId, month]
  );

  if (!rows.length) return;

  const evidence = rows[0].reasoning?.evidence;
  if (!evidence) return;

  const nudges = evaluateCoachingRules(evidence).slice(0, 2);

  for (const nudge of nudges) {
    // 🔒 Prevent duplicates
    const { rows: existing } = await pool.query(
      `
      SELECT 1
      FROM workspace_coaching_nudges
      WHERE workspace_id = $1
        AND user_id = $2
        AND period = $3
        AND nudge_type = $4
      LIMIT 1
      `,
      [workspaceId, userId, month, nudge.type]
    );

    if (existing.length) continue;

    const message = buildCoachingMessage(nudge);

    await saveCoachingNudge({
      workspaceId,
      userId,
      period: month,
      nudgeType: nudge.type,
      message,
      evidence: nudge.evidence,
      expectedImpact: nudge.expectedImpact,
    });

    try {
      await sendCoachingNotification({
        userId,
        workspaceId,
        message,
        expectedImpact: nudge.expectedImpact,
      });
    } catch (err) {
      console.error(
        "Failed to send coaching notification",
        err.message
      );
    }
  }
}
