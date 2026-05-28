// repositories/superadminWorkspaces.repository.js
import pool from "../db.js";
import crypto from "crypto";
import { ensureDefaultChannelsForWorkspace } from "../services/workspace.service.js";
import { ensureSystemUser } from "../services/ai.system.service.js";

/** SHA-256 of the lowercased email domain — used for trial anti-abuse tracking */
function emailDomainFingerprint(email) {
  const domain = (email.split("@")[1] || email).toLowerCase().trim();
  return crypto.createHash("sha256").update(domain).digest("hex");
}

export async function createWorkspace({
  name,
  plan = "basic",
  ownerEmail,
  ownerPasswordHash,
  ownerName = null,
  ipHash = null,
}) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const isTrial = plan === "trial";
    const normalizedOwnerEmail = String(ownerEmail || "").trim().toLowerCase();

    const existingOwner = await client.query(
      `SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [normalizedOwnerEmail]
    );
    if (existingOwner.rows.length > 0) {
      throw new Error("An account already exists with this email. Please sign in.");
    }

    // ── Anti-abuse: each email domain gets ONE free trial ───────────────────
    if (isTrial) {
      const fingerprint = emailDomainFingerprint(normalizedOwnerEmail);
      const existing = await client.query(
        `SELECT id FROM trial_fingerprints WHERE fingerprint_hash = $1 LIMIT 1`,
        [fingerprint]
      );
      if (existing.rows.length > 0) {
        throw new Error(
          "This email domain has already used a free trial. Please select a paid plan."
        );
      }

      // ── Anti-abuse: each IP address gets ONE free trial ──────────────────
      if (ipHash) {
        const ipUsed = await client.query(
          `SELECT id FROM trial_fingerprints WHERE ip_hash = $1 LIMIT 1`,
          [ipHash]
        );
        if (ipUsed.rows.length > 0) {
          throw new Error(
            "A free trial has already been created from this IP address. Please select a paid plan."
          );
        }
      }
    }

    // ── Resolve member limit from billing plan (trial = unlimited) ──────────
    let memberLimit = null;
    if (!isTrial) {
      const planRow = await client.query(
        `SELECT member_limit FROM billing_plans WHERE slug = $1 LIMIT 1`,
        [plan]
      );
      memberLimit = planRow.rows[0]?.member_limit ?? null;
    }

    // billing_plan stays NULL during trial — features come from trial window
    const billingPlan = isTrial ? null : plan;
    const trialStart  = isTrial ? new Date() : null;
    const trialEnd    = isTrial ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) : null;

    // ── Create workspace ─────────────────────────────────────────────────────
    const { rows: [workspace] } = await client.query(
      `INSERT INTO workspaces (
         id, name, plan, member_limit, billing_plan, max_members, is_active,
         trial_started_at, trial_ends_at, created_at, updated_at
       ) VALUES (
         gen_random_uuid(), $1, $2, $3, $4, $3, true,
         $5, $6, now(), now()
       ) RETURNING *`,
      [name, billingPlan, memberLimit, billingPlan, trialStart, trialEnd]
    );

    // ── Store trial fingerprint so the domain/IP can't claim another trial ───
    if (isTrial) {
      const fingerprint = emailDomainFingerprint(normalizedOwnerEmail);
      await client.query(
        `INSERT INTO trial_fingerprints (workspace_id, fingerprint_hash, ip_hash) VALUES ($1, $2, $3)`,
        [workspace.id, fingerprint, ipHash || null]
      );
    }

    // ── Create owner (admin) user ────────────────────────────────────────────
    const { rows: [owner] } = await client.query(
      `INSERT INTO users (
         id, username, email, password_hash, role, workspace_id, created_at
       ) VALUES (
         gen_random_uuid(), $1, $2, $3, 'admin', $4, now()
       ) RETURNING id, username, email, role, workspace_id`,
      [ownerName || normalizedOwnerEmail.split("@")[0], normalizedOwnerEmail, ownerPasswordHash || null, workspace.id]
    );

    await client.query(
      `INSERT INTO workspace_users (
         workspace_id, user_id, role, billing_status, activated_at, cycle_start, cycle_end
       ) VALUES (
         $1, $2, 'admin', $3, $4, $4, NULL
       )
       ON CONFLICT (user_id) DO NOTHING`,
      [
        workspace.id,
        owner.id,
        isTrial ? "trial" : "active",
        isTrial ? null : new Date(),
      ]
    );

    await client.query(
      `UPDATE workspaces
       SET owner_user_id = $2,
           created_by = COALESCE(created_by, $2),
           updated_at = now()
       WHERE id = $1`,
      [workspace.id, owner.id]
    );

    // ── Ensure system (AI) user ──────────────────────────────────────────────
    const systemUser = await ensureSystemUser(workspace.id, client);

    await client.query("COMMIT");

    // ── Default channels (post-TX, safe) ────────────────────────────────────
    await ensureDefaultChannelsForWorkspace(workspace.id, owner.id);

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
  const allowed = ["name", "plan"];
  const sets = [];
  const values = [];
  let idx = 1;

  for (const key of allowed) {
    if (data[key] !== undefined) {
      sets.push(`${key} = $${idx++}`);
      values.push(data[key]);
      if (key === "plan") {
        sets.push(`billing_plan = $${idx++}`);
        values.push(data[key]);
        // Sync max_members from billing plan (null = unlimited)
        const planRow = await pool.query(
          `SELECT member_limit FROM billing_plans WHERE slug = $1 LIMIT 1`,
          [data[key]]
        );
        const memberLimit = planRow.rows[0]?.member_limit ?? null;
        sets.push(`member_limit = $${idx++}`);
        values.push(memberLimit);
        sets.push(`max_members = $${idx++}`);
        values.push(memberLimit);
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

export async function hardDeleteWorkspace(id) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── Level 1: comments referencing tasks in this workspace ──
    await client.query(
      `DELETE FROM comments WHERE task_id IN (SELECT id FROM tasks WHERE workspace_id = $1)`,
      [id]
    );

    // ── Level 2: tasks (cascades task_activity_logs, task_attachments, task_watchers, etc.) ──
    await client.query(`DELETE FROM tasks             WHERE workspace_id = $1`, [id]);

    // ── Level 3: sprint/project children ──
    await client.query(`DELETE FROM sprints           WHERE workspace_id = $1`, [id]);
    await client.query(`DELETE FROM projects          WHERE workspace_id = $1`, [id]);

    // ── Level 4: chat — workspace_id may be NULL on old rows, so also delete by user_id ──
    await client.query(
      `DELETE FROM chat_messages
       WHERE workspace_id = $1
          OR user_id IN (SELECT id FROM users WHERE workspace_id = $1)`,
      [id]
    );
    await client.query(`DELETE FROM chat_channel_members WHERE workspace_id = $1`, [id]);
    await client.query(`DELETE FROM chat_channel_admins  WHERE workspace_id = $1`, [id]);
    await client.query(`DELETE FROM chat_channels        WHERE workspace_id = $1`, [id]);

    // ── Level 5: workspace_users + system_users (must go before users) ──
    await client.query(`DELETE FROM workspace_users   WHERE workspace_id = $1`, [id]);
    await client.query(`DELETE FROM system_users      WHERE workspace_id = $1`, [id]);

    // ── Level 6: users ──
    await client.query(`DELETE FROM users             WHERE workspace_id = $1`, [id]);

    // ── Level 7: workspace itself (cascades payments, subscriptions, billing, etc.) ──
    await client.query(`DELETE FROM workspaces        WHERE id = $1`, [id]);

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("hardDeleteWorkspace error:", err.message);
    throw err;
  } finally {
    client.release();
  }
}
