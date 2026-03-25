// repositories/superadminWorkspaces.repository.js
import pool from "../db.js";
import crypto from "crypto";
import { ensureDefaultChannelsForWorkspace } from "../services/workspace.service.js";
import { ensureSystemUser } from "../services/ai.system.service.js";

function genUuid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : crypto.createHash("sha1").update(String(Date.now()) + Math.random()).digest("hex");
}

// repositories/superadminWorkspaces.repository.js

export async function createWorkspace({
  name,
  plan = "basic",
  member_limit = 10,
  ownerEmail,
  ownerPasswordHash,
  ownerName = null,
}) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1️⃣ Create workspace — sync both column pairs so limit enforcement works
    const limit = Number(member_limit) || 10;
    const { rows: [workspace] } = await client.query(
      `
      INSERT INTO workspaces (
        id, name, plan, member_limit, billing_plan, max_members, is_active, created_at, updated_at
      )
      VALUES (
        gen_random_uuid(), $1, $2, $3, $2, $3, true, now(), now()
      )
      RETURNING *
      `,
      [name, plan, limit]
    );

    // 2️⃣ Create owner user
    const { rows: [owner] } = await client.query(
      `
      INSERT INTO users (
        id, username, email, password_hash, role, workspace_id, created_at
      )
      VALUES (
        gen_random_uuid(), $1, $2, $3, 'admin', $4, now()
      )
      RETURNING id, username, email, role, workspace_id
      `,
      [
        ownerName || ownerEmail.split("@")[0],
        ownerEmail,
        ownerPasswordHash,
        workspace.id,
      ]
    );

    // 3️⃣ ENSURE system (AI) user — ONLY via service
    // ⚠️ DO NOT manually insert into system_users
    const systemUser = await ensureSystemUser(workspace.id, client);

    await client.query("COMMIT");

    // 4️⃣ Default channels (post-TX, safe)
    await ensureDefaultChannelsForWorkspace(workspace.id, owner.id);

    return {
      workspace,
      owner,
      systemUser,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("createWorkspace TX error:", err);
    throw err;
  } finally {
    client.release();
  }
}

export async function listWorkspaces() {
  const res = await pool.query(`
    SELECT
      w.*,
      u.email  AS owner_email,
      u.username AS owner_name,
      u.id     AS owner_id,
      (SELECT COUNT(*)::int FROM users WHERE workspace_id = w.id) AS user_count
    FROM workspaces w
    LEFT JOIN LATERAL (
      SELECT id, email, username
      FROM users
      WHERE workspace_id = w.id AND role = 'admin'
      ORDER BY created_at ASC
      LIMIT 1
    ) u ON true
    ORDER BY w.created_at DESC
  `);
  return res.rows;
}

export async function getPlatformStats() {
  const res = await pool.query(`
    SELECT
      COUNT(*)::int                                                          AS total_workspaces,
      COUNT(*) FILTER (WHERE is_active = true)::int                         AS active_workspaces,
      COUNT(*) FILTER (WHERE is_active = false)::int                        AS suspended_workspaces,
      (SELECT COUNT(*)::int FROM users)                                      AS total_users,
      (SELECT COUNT(*)::int FROM workspaces WHERE created_at > now() - interval '30 days') AS new_this_month
    FROM workspaces
  `);
  return res.rows[0];
}

export async function getWorkspace(id) {
  const res = await pool.query(
    `SELECT * FROM workspaces WHERE id = $1 LIMIT 1`,
    [id]
  );
  return res.rows[0] || null;
}

export async function updateWorkspace(id, data = {}) {
  const allowed = ["name", "plan", "member_limit"];
  const sets = [];
  const values = [];
  let idx = 1;

  for (const key of allowed) {
    if (data[key] !== undefined) {
      sets.push(`${key} = $${idx++}`);
      values.push(data[key]);
      // Keep enforcement columns in sync
      if (key === "plan") {
        sets.push(`billing_plan = $${idx++}`);
        values.push(data[key]);
      }
      if (key === "member_limit") {
        sets.push(`max_members = $${idx++}`);
        values.push(data[key]);
      }
    }
  }

  if (!sets.length) throw new Error("Nothing to update");

  sets.push(`updated_at = now()`);
  values.push(id);

  const res = await pool.query(
    `UPDATE workspaces SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    values
  );

  return res.rows[0];
}

export async function updateWorkspaceStatus(id, is_active) {
  const res = await pool.query(
    `UPDATE workspaces SET is_active = $1, updated_at = now() WHERE id = $2 RETURNING *`,
    [is_active, id]
  );
  return res.rows[0];
}

export async function deleteWorkspace(id) {
  await pool.query(
    `UPDATE workspaces SET is_active = false, updated_at = now() WHERE id = $1`,
    [id]
  );
}
