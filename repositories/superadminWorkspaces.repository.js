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

    // 1️⃣ Creating Workspace
    const insWs = await client.query(
      `INSERT INTO workspaces (id, name, plan, member_limit, is_active, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, true, now(), now())
       RETURNING *`,
      [name, plan, Number(member_limit) || 10]
    );

    const workspace = insWs.rows[0];

    // 2️⃣ Creating Owner
    const ownerInsert = await client.query(
      `INSERT INTO users (id, username, email, password_hash, role, workspace_id, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'admin', $4, now())
       RETURNING id, username, email, role, workspace_id`,
      [
        ownerName || ownerEmail.split("@")[0],
        ownerEmail,
        ownerPasswordHash,
        workspace.id,
      ]
    );

    const owner = ownerInsert.rows[0];

    // 3️⃣ Ensuring System User (AI)
    const systemUserInsert = await client.query(
      `INSERT INTO system_users (id, email, workspace_id, created_at)
       VALUES (gen_random_uuid(), 'ai@${workspace.id}.com', $1, now())
       RETURNING id, email, workspace_id, created_at`,
      [workspace.id]
    );

    const systemUser = systemUserInsert.rows[0];

    await client.query("COMMIT");
    await ensureSystemUser(workspace.id);

    // ✅ ENSURE DEFAULT CHANNELS (OUTSIDE TX, SAFE)
    await ensureDefaultChannelsForWorkspace(workspace.id, owner.id);

    // Return workspace, owner, and AI system user
    return { workspace, owner, systemUser };
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("createWorkspace TX error:", err);
    throw err;
  } finally {
    client.release();
  }
}

export async function listWorkspaces() {
  const res = await pool.query(
    `SELECT * FROM workspaces ORDER BY created_at DESC`
  );
  return res.rows;
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
