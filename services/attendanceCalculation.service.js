export async function recalculateDailyAttendance(
  userId,
  workspaceId,
  timestamp
) {
  const date = new Date(timestamp).toISOString().slice(0, 10);

  const { rows: events } = await pool.query(
    `
    SELECT
      event_type,
      started_at,
      ended_at
    FROM attendance_events
    WHERE user_id = $1
      AND workspace_id = $2
      AND DATE(started_at) = $3
    ORDER BY started_at ASC
    `,
    [userId, workspaceId, date]
  );

  if (!events.length) return;

  let signInAt = null;
  let signOffAt = null;

  let awsMinutes = 0;
  let lunchMinutes = 0;
  let screenOnMinutes = 0;

  for (const e of events) {
    switch (e.event_type) {
      case "SIGN_IN":
        if (!signInAt) signInAt = e.started_at;
        break;

      case "SIGN_OFF":
        signOffAt = e.ended_at;
        break;

      case "AWS":
        if (e.started_at && e.ended_at) {
          awsMinutes += (e.ended_at - e.started_at) / 60000;
        }
        break;

      case "LUNCH":
        if (e.started_at && e.ended_at) {
          lunchMinutes += (e.ended_at - e.started_at) / 60000;
        }
        break;

      case "SCREEN_ON":
        if (e.started_at && e.ended_at) {
          screenOnMinutes += (e.ended_at - e.started_at) / 60000;
        }
        break;
    }
  }

  if (!signInAt || !signOffAt) return;

  const totalSignedInMinutes =
    (new Date(signOffAt) - new Date(signInAt)) / 60000;

  const availableMinutes =
    totalSignedInMinutes - awsMinutes - lunchMinutes;

  const screenOffMinutes =
    totalSignedInMinutes - screenOnMinutes;

  await pool.query(
    `
    INSERT INTO daily_attendance (
      user_id,
      workspace_id,
      date,
      total_signed_in_minutes,
      aws_minutes,
      lunch_minutes,
      available_minutes,
      screen_on_minutes,
      screen_off_minutes
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (user_id, workspace_id, date)
    DO UPDATE SET
      total_signed_in_minutes = EXCLUDED.total_signed_in_minutes,
      aws_minutes = EXCLUDED.aws_minutes,
      lunch_minutes = EXCLUDED.lunch_minutes,
      available_minutes = EXCLUDED.available_minutes,
      screen_on_minutes = EXCLUDED.screen_on_minutes,
      screen_off_minutes = EXCLUDED.screen_off_minutes,
      updated_at = NOW()
    `,
    [
      userId,
      workspaceId,
      date,
      totalSignedInMinutes,
      awsMinutes,
      lunchMinutes,
      availableMinutes,
      screenOnMinutes,
      screenOffMinutes,
    ]
  );
}
