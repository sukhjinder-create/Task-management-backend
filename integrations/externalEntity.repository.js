import pool from "../db.js";
import { randomUUID } from "crypto";

/**
 * Resolve stable internal UUID for an external entity.
 * Safe against concurrency & duplicate inserts.
 */
export async function resolveInternalEntityId({
  workspaceId,
  provider,
  externalId,
  entityType,
}) {

  // Try inserting first (atomic approach)
  const internalId = randomUUID();

  await pool.query(
    `
    INSERT INTO external_entities
      (workspace_id, provider, external_id, entity_type, internal_entity_id)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (workspace_id, provider, external_id, entity_type)
    DO NOTHING
    `,
    [workspaceId, provider, externalId, entityType, internalId]
  );

  // Always fetch the canonical mapping
  const result = await pool.query(
    `
    SELECT internal_entity_id
    FROM external_entities
    WHERE workspace_id = $1
      AND provider = $2
      AND external_id = $3
      AND entity_type = $4
    LIMIT 1
    `,
    [workspaceId, provider, externalId, entityType]
  );

  return result.rows[0].internal_entity_id;
}
