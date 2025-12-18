// repositories/workspace.repository.js
import pool from "../db.js";

/**
 * Workspace repository — CRUD + membership helpers.
 */

/* ----------------- Workspaces ----------------- */

export async function createWorkspace({ name, slug = null, createdBy = null, billing_plan = null, max_members = 10, metadata = null }) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `INSERT INTO workspaces (id, name, slug, billing_plan, max_members, created_by, metadata, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, now())
       RETURNING *`,
      [name, slug, billing_plan, max_members, createdBy, metadata]
    );
    return res.rows[0];
  } finally {
    client.release();
  }
}

export async function getWorkspaceById(id) {
  const { rows } = await pool.query(
    `SELECT * FROM workspaces WHERE id = $1 LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

export async function listWorkspaces({ limit = 50, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM workspaces ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows;
}

/* -------------- Membership helpers -------------- */

export async function addWorkspaceUser(workspaceId, userId, role = "member") {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO workspace_users (id, workspace_id, user_id, role, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, now())`,
      [workspaceId, userId, role]
    );
  } finally {
    client.release();
  }
}

export async function removeWorkspaceUser(workspaceId, userId) {
  await pool.query(
    `DELETE FROM workspace_users WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId]
  );
}

export async function getWorkspaceUser(workspaceId, userId) {
  const { rows } = await pool.query(
    `SELECT * FROM workspace_users WHERE workspace_id = $1 AND user_id = $2 LIMIT 1`,
    [workspaceId, userId]
  );
  return rows[0] || null;
}

export async function getWorkspaceUserByUserId(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM workspace_users WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

export async function countWorkspaceMembers(workspaceId) {
  const { rows } = await pool.query(
    `SELECT count(*)::int as cnt FROM workspace_users WHERE workspace_id = $1`,
    [workspaceId]
  );
  return rows[0]?.cnt || 0;
}

/* ==================================================
   Phase 2.2 — SuperAdmin / Enforcement helpers
   (ADDITIVE ONLY)
   ================================================== */

/**
 * Update workspace status: active | suspended | deleted
 * Intended for SuperAdmin use only.
 */
export async function updateWorkspaceStatus(workspaceId, status) {
  const { rows } = await pool.query(
    `UPDATE workspaces
     SET status = $2
     WHERE id = $1
     RETURNING *`,
    [workspaceId, status]
  );
  return rows[0] || null;
}

/**
 * Update billing plan (free | pro | enterprise | etc)
 */
export async function updateWorkspacePlan(workspaceId, billing_plan) {
  const { rows } = await pool.query(
    `UPDATE workspaces
     SET billing_plan = $2
     WHERE id = $1
     RETURNING *`,
    [workspaceId, billing_plan]
  );
  return rows[0] || null;
}

/**
 * Soft delete workspace (enforced via status)
 */
export async function softDeleteWorkspace(workspaceId) {
  return updateWorkspaceStatus(workspaceId, "deleted");
}

/**
 * Minimal workspace fetch for middleware enforcement.
 * Avoids over-fetching.
 */
export async function getWorkspaceForEnforcement(workspaceId) {
  const { rows } = await pool.query(
    `SELECT id, status, billing_plan
     FROM workspaces
     WHERE id = $1
     LIMIT 1`,
    [workspaceId]
  );
  return rows[0] || null;
}
