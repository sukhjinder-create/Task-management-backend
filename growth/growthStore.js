import pool from "../db.js";

const COLUMNS = [
  "id", "event_name", "category", "source", "actor_user_id", "workspace_id",
  "anonymous_id", "session_id", "entity_type", "entity_id", "page_path",
  "landing_page", "referrer_host", "traffic_source", "utm_source", "utm_medium",
  "utm_campaign", "device_type", "browser", "country_code", "properties", "occurred_at",
];

export async function insertGrowthEvents(events) {
  if (!events.length) return 0;
  const values = [];
  const rows = events.map((event, rowIndex) => {
    const offset = rowIndex * COLUMNS.length;
    values.push(
      event.id, event.eventName, event.category, event.source, event.actorUserId,
      event.workspaceId, event.anonymousId, event.sessionId, event.entityType,
      event.entityId, event.pagePath, event.landingPage, event.referrerHost,
      event.trafficSource, event.utmSource, event.utmMedium, event.utmCampaign,
      event.deviceType, event.browser, event.countryCode,
      JSON.stringify(event.properties || {}), event.occurredAt
    );
    return `(${COLUMNS.map((_, index) => `$${offset + index + 1}`).join(", ")})`;
  });

  const result = await pool.query(
    `INSERT INTO growth_events (${COLUMNS.join(", ")})
     VALUES ${rows.join(", ")}
     ON CONFLICT (id) DO NOTHING`,
    values
  );
  return result.rowCount;
}

