// repositories/superadminWorkspaces.repository.js
import pool from "../db.js";
import { generateUniqueSlug } from "../services/workspaceSlug.service.js";
import crypto from "crypto";
import { ensureDefaultChannelsForWorkspace } from "../services/workspace.service.js";
import { ensureSystemUser } from "../services/ai.system.service.js";

/** Non-identifying per-trial marker; email uniqueness is enforced from users.email. */
function trialRecordFingerprint(email, workspaceId) {
  return crypto
    .createHash("sha256")
    .update(`${String(email || "").toLowerCase().trim()}:${workspaceId}`)
    .digest("hex");
}

export async function createWorkspace({
  name,
  plan = "basic",
  ownerEmail,
  ownerPasswordHash,
  ownerName = null,
  ipHash = null,
  skipTrialIpCheck = false,
  metadata = null,
  trialEndsAt = null,
  signupCountryCode = null,
  signupMethod = null,
  ownerEmailVerifiedAt = null,
  ownerEmailVerificationMethod = null,
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

    // ── Anti-abuse: an existing platform email cannot create another workspace.
    // Same company/domain is allowed; multiple teams at one company can trial.
    if (isTrial) {
      // ── Anti-abuse: each IP address gets ONE free trial ──────────────────
      if (ipHash && !skipTrialIpCheck) {
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
    const trialEnd    = isTrial
      ? trialEndsAt || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      : null;

    // ── Create workspace ─────────────────────────────────────────────────────
    // The slug is what makes the workspace reachable at <slug>.asystence.com.
    // This insert previously omitted it, so every workspace created through
    // this path -- superadmin creation and self-serve trial signup, i.e. most
    // real workspaces -- was born unroutable, and the edge 404s a slug it
    // cannot resolve. Generated inside the caller's transaction so the
    // uniqueness check and the insert cannot be separated by a concurrent
    // signup claiming the same slug.
    const slug = await generateUniqueSlug(name, { client });

    const { rows: [workspace] } = await client.query(
      `INSERT INTO workspaces (
         id, name, slug, plan, member_limit, billing_plan, max_members, is_active,
         trial_started_at, trial_ends_at, metadata, signup_country_code,
         signup_method, created_at, updated_at
       ) VALUES (
         gen_random_uuid(), $1, $2, $3, $4, $5, $4, true,
         $6, $7, $8, $9, $10, now(), now()
       ) RETURNING *`,
      [
        name,
        slug,
        billingPlan,
        memberLimit,
        billingPlan,
        trialStart,
        trialEnd,
        metadata,
        signupCountryCode,
        signupMethod,
      ]
    );

    // ── Store trial fingerprint + IP marker for future audit/IP protection ───
    if (isTrial) {
      const fingerprint = trialRecordFingerprint(normalizedOwnerEmail, workspace.id);
      await client.query(
        `INSERT INTO trial_fingerprints (workspace_id, fingerprint_hash, ip_hash) VALUES ($1, $2, $3)`,
        [workspace.id, fingerprint, ipHash || null]
      );
    }

    // ── Create owner (admin) user ────────────────────────────────────────────
    const { rows: [owner] } = await client.query(
      `INSERT INTO users (
         id, username, email, password_hash, role, workspace_id,
         email_verified_at, email_verification_method, created_at
       ) VALUES (
         gen_random_uuid(), $1, $2, $3, 'admin', $4, $5, $6, now()
       ) RETURNING id, username, email, role, workspace_id`,
      [
        ownerName || normalizedOwnerEmail.split("@")[0],
        normalizedOwnerEmail,
        ownerPasswordHash || null,
        workspace.id,
        ownerEmailVerifiedAt,
        ownerEmailVerificationMethod,
      ]
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
      u.email_verified_at AS owner_email_verified_at,
      u.email_verification_method AS owner_email_verification_method,
      (SELECT COUNT(*)::int FROM users WHERE workspace_id = w.id) AS user_count,
      (SELECT COUNT(*)::int FROM projects WHERE workspace_id = w.id) AS project_count
    FROM workspaces w
    LEFT JOIN LATERAL (
      SELECT id, email, username, email_verified_at, email_verification_method
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

export async function listWorkspaceProjects(workspaceId) {
  const { rows } = await pool.query(
    `SELECT
       p.id,
       p.name,
       p.project_code,
       COALESCE(creator.username, creator.email) AS added_by_name,
       p.created_at,
       p.updated_at,
       COUNT(t.id)::int AS task_count
     FROM projects p
     LEFT JOIN tasks t
       ON t.project_id = p.id
      AND t.workspace_id = p.workspace_id
     LEFT JOIN users creator
       ON creator.id::text = p.added_by
      AND creator.workspace_id = p.workspace_id
     WHERE p.workspace_id = $1
     GROUP BY p.id, creator.username, creator.email
     ORDER BY p.created_at DESC`,
    [workspaceId]
  );
  return rows;
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
