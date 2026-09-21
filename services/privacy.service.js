import db from "../db.js";
import { logAuditRequired } from "./audit.service.js";

const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;
const SENSITIVE_FIELD = /(?:password|secret|token_hash|key_hash|private_key|mfa_|public_key_jwk)/i;

function redactRecord(record) {
  return Object.fromEntries(Object.entries(record || {}).map(([key, value]) => [
    key,
    SENSITIVE_FIELD.test(key) ? "[REDACTED]" : value,
  ]));
}

export async function collectPersonalData({ userId, workspaceId, database = db }) {
  const relations = await database.query(
    `SELECT tc.table_name, kcu.column_name,
            EXISTS (
              SELECT 1 FROM information_schema.columns workspace_column
               WHERE workspace_column.table_schema = tc.table_schema
                 AND workspace_column.table_name = tc.table_name
                 AND workspace_column.column_name = 'workspace_id'
            ) AS has_workspace
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_schema = tc.constraint_schema
        AND kcu.constraint_name = tc.constraint_name
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_schema = tc.constraint_schema
        AND ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
        AND ccu.table_name = 'users'
        AND ccu.column_name = 'id'
        AND kcu.column_name <> 'workspace_id'
      ORDER BY tc.table_name, kcu.column_name`
  );

  const grouped = new Map();
  for (const relation of relations.rows) {
    const current = grouped.get(relation.table_name) || { columns: [], hasWorkspace: relation.has_workspace };
    current.columns.push(relation.column_name);
    grouped.set(relation.table_name, current);
  }

  const data = {};
  for (const [table, relation] of grouped) {
    const predicates = relation.columns.map((column, index) => `${quoteIdentifier(column)} = $1`).join(" OR ");
    const workspacePredicate = relation.hasWorkspace ? " AND workspace_id = $2" : "";
    const result = await database.query(
      `SELECT to_jsonb(source) AS record FROM ${quoteIdentifier("public")}.${quoteIdentifier(table)} source
        WHERE (${predicates})${workspacePredicate}`,
      relation.hasWorkspace ? [userId, workspaceId] : [userId]
    );
    if (result.rows.length) data[table] = result.rows.map(({ record }) => redactRecord(record));
  }

  const profile = await database.query(
    `SELECT to_jsonb(app_user) AS record FROM users app_user
      WHERE id = $1 AND workspace_id = $2`,
    [userId, workspaceId]
  );
  return {
    schema_version: 1,
    exported_at: new Date().toISOString(),
    subject: profile.rows[0] ? redactRecord(profile.rows[0].record) : null,
    records: data,
    manifest: Object.fromEntries(Object.entries(data).map(([table, rows]) => [table, rows.length])),
  };
}

async function tableHasColumn(client, table, column) {
  const result = await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return Boolean(result.rows[0]);
}

export async function executeErasure({ requestId, workspaceId, processedBy, notes = null, database = db }) {
  const client = await database.connect();
  let userId;
  try {
    await client.query("BEGIN");
    const request = await client.query(
      `SELECT * FROM gdpr_erasure_requests
        WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
      [requestId, workspaceId]
    );
    if (!request.rows[0]) throw Object.assign(new Error("Erasure request not found"), { statusCode: 404 });
    if (request.rows[0].status === "completed") {
      await client.query("ROLLBACK");
      return request.rows[0];
    }
    userId = request.rows[0].user_id;
    const hold = await client.query(
      `SELECT id, reason, reference FROM privacy_legal_holds
        WHERE workspace_id = $1 AND user_id = $2 AND active = true LIMIT 1`,
      [workspaceId, userId]
    );
    if (hold.rows[0]) throw Object.assign(new Error("Erasure is blocked by an active legal hold"), { statusCode: 409, hold: hold.rows[0] });

    await client.query(
      `UPDATE gdpr_erasure_requests SET status = 'processing', processed_by = $1,
              processing_started_at = now(), notes = $2
        WHERE id = $3 AND workspace_id = $4`,
      [processedBy, notes, requestId, workspaceId]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    throw error;
  }

  // The final identifiable event is committed before profile anonymization;
  // audit records are retained under the workspace's legal/compliance basis.
  try {
    await logAuditRequired({
      workspaceId, userId: processedBy, action: "gdpr.erasure.execute",
      entityType: "user", entityId: userId, metadata: { request_id: requestId },
    }, database);
  } catch (error) {
    client.release();
    throw error;
  }

  try {
    await client.query("BEGIN");
    const credentialTables = [
      ["user_sessions", "user_id"], ["password_reset_tokens", "user_id"],
      ["magic_link_tokens", "user_id"], ["email_verification_tokens", "user_id"],
      ["push_subscriptions", "user_id"], ["user_keys", "user_id"],
      ["gdpr_consents", "user_id"], ["scim_external_identities", "user_id"],
    ];
    const removed = {};
    for (const [table, column] of credentialTables) {
      if (!(await tableHasColumn(client, table, column))) continue;
      const result = await client.query(
        `DELETE FROM ${quoteIdentifier("public")}.${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} = $1`,
        [userId]
      );
      removed[table] = result.rowCount;
    }

    const pseudonym = `Deleted user ${String(userId).slice(0, 8)}`;
    const email = `deleted+${userId}@erased.invalid`;
    const user = await client.query(
      `UPDATE users SET username = $1, email = $2, password = NULL,
              password_hash = NULL, avatar_url = NULL, added_by = NULL,
              public_key_jwk = NULL, mfa_secret = NULL, mfa_enabled = false,
              mfa_backup_codes = NULL, projects = '{}'::uuid[], disabled_at = now(), updated_at = now()
        WHERE id = $3 AND workspace_id = $4 RETURNING id`,
      [pseudonym, email, userId, workspaceId]
    );
    if (!user.rows[0]) throw Object.assign(new Error("Erasure subject not found"), { statusCode: 404 });
    await client.query(
      `UPDATE workspace_users SET billing_status = 'pending', enterprise_role_id = NULL
        WHERE user_id = $1 AND workspace_id = $2`,
      [userId, workspaceId]
    );
    const resultPayload = { anonymized: true, credentials_removed: removed };
    const completed = await client.query(
      `UPDATE gdpr_erasure_requests SET status = 'completed', completed_at = now(), result = $1
        WHERE id = $2 AND workspace_id = $3 RETURNING *`,
      [JSON.stringify(resultPayload), requestId, workspaceId]
    );
    await client.query("COMMIT");
    return completed.rows[0];
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    await database.query(
      `UPDATE gdpr_erasure_requests SET status = 'pending',
              notes = concat_ws(E'\n', notes, $1)
        WHERE id = $2 AND workspace_id = $3`,
      [`Processing failed: ${error.message}`.slice(0, 1000), requestId, workspaceId]
    ).catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export const __testables = { quoteIdentifier, redactRecord };
