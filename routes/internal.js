import pool from "../db.js";
import express from "express";
import { createAIChatMessage } from "../services/chat.service.js";
import { getProjectReport } from "../services/reports.service.js";
import { materializeDashboardHistoryInternal } from "../intelligence/intelligence.controller.js";
import { certifyEnterpriseIntelligenceCoreWorkspace } from "../intelligence/certification/coreCertification.service.js";
import { traceUserScoreForWorkspace } from "../intelligence/certification/userScoreTrace.service.js";

console.log("🔥 INTERNAL ROUTES LOADED");

const router = express.Router();

router.post("/dashboard-history/materialize", materializeDashboardHistoryInternal);

function internalToken(req) {
  return (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
}

function internalSecretMatches(req) {
  const expected = process.env.INTERNAL_SERVICE_SECRET || process.env.AI_SERVICE_SECRET || "";
  const provided =
    internalToken(req) ||
    req.headers["x-internal-service-secret"] ||
    req.headers["x-ai-service-secret"] ||
    req.body?.secret ||
    "";
  return Boolean(expected && provided === expected);
}

router.post("/enterprise-intelligence/certify-core", async (req, res) => {
  try {
    if (!internalSecretMatches(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const result = await certifyEnterpriseIntelligenceCoreWorkspace({
      workspaceId: req.body?.workspaceId,
      executeCutover: req.body?.executeCutover === true,
      updatedBy: req.body?.updatedBy || null,
      ranges: req.body?.ranges,
    });

    return res.status(result.certified ? 200 : 409).json(result);
  } catch (err) {
    const status = err?.code === "CERTIFICATION_WORKSPACE_REQUIRED" ? 400 : 500;
    console.error("[ENTERPRISE_INTELLIGENCE_CERTIFICATION_ERROR]", err);
    return res.status(status).json({
      error: err.message || "Enterprise intelligence certification failed",
      code: err.code || null,
    });
  }
});

router.post("/enterprise-intelligence/user-score-trace", async (req, res) => {
  try {
    if (!internalSecretMatches(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const result = await traceUserScoreForWorkspace({
      workspaceId: req.body?.workspaceId || null,
      workspaceName: req.body?.workspaceName || "Apyhub",
      userId: req.body?.userId || null,
      userSearch: req.body?.userSearch || "Sukhjinder",
      includeRecomputed: req.body?.includeRecomputed !== false,
    });

    return res.json(result);
  } catch (err) {
    const status = err?.code === "TRACE_WORKSPACE_NOT_FOUND" || err?.code === "TRACE_USER_NOT_FOUND"
      ? 404
      : 500;
    console.error("[ENTERPRISE_INTELLIGENCE_USER_SCORE_TRACE_ERROR]", err);
    return res.status(status).json({
      error: err.message || "Enterprise intelligence user score trace failed",
      code: err.code || null,
    });
  }
});

/**
 * 🔒 Internal AI reply endpoint
 * Called ONLY by AI service
 */
router.post("/ai/reply", async (req, res) => {
  try {
    // 🔐 Shared-secret auth
    const auth = req.headers.authorization || "";
    const token = auth.replace("Bearer ", "");

    if (token !== process.env.AI_SERVICE_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const {
      channelKey,
      workspaceId,
      textHtml,
      parentId = null,
    } = req.body || {};

    if (!channelKey || !workspaceId || !textHtml) {
      return res.status(400).json({
        error: "channelKey, workspaceId, textHtml are required",
      });
    }

    const msg = await createAIChatMessage({
      channelKey,
      workspaceId,
      textHtml,
      parentId,
    });

    return res.json({
      success: true,
      messageId: msg.id,
    });
  } catch (err) {
    console.error("[INTERNAL_AI_REPLY_ERROR]", err);
    return res.status(500).json({ error: "AI reply failed" });
  }
});

/**
 * 🔒 Internal AI → Read workspace AI settings
 * Used ONLY by AI service (no JWT, no user auth)
 */
/**
 * 🔐 Internal: Read workspace AI settings
 * Used ONLY by AI service (no JWT)
 */
router.get("/workspace-ai-settings/:workspaceId", async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.replace("Bearer ", "");

    if (token !== process.env.AI_SERVICE_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { workspaceId } = req.params;

    const { rows } = await pool.query(
      `
      SELECT ai_enabled, ai_auto_reply
      FROM workspace_ai_settings
      WHERE workspace_id = $1
      `,
      [workspaceId]
    );

    // Default = enabled
    res.json(
      rows[0] || {
        ai_enabled: true,
        ai_auto_reply: true,
      }
    );
  } catch (err) {
    console.error("[INTERNAL_AI_SETTINGS_ERROR]", err);
    res.status(500).json({ error: "Failed to fetch AI settings" });
  }
});

/**
 * 🔒 Internal: Ensure a user's private AI notification channel exists.
 * Creates it if missing. Returns the stable channel key.
 * Channel name = the AI name set in workspace settings.
 */
router.post("/ai/ensure-notify-channel", async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.replace("Bearer ", "");
    if (token !== process.env.AI_SERVICE_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { userId, workspaceId } = req.body || {};
    if (!userId || !workspaceId) {
      return res.status(400).json({ error: "userId and workspaceId required" });
    }

    // Stable, predictable key — one per user
    const channelKey = `ai-notify:${userId}`;

    // Return existing channel if already created
    const existing = await pool.query(
      `SELECT key FROM chat_channels WHERE key = $1 AND workspace_id = $2`,
      [channelKey, workspaceId]
    );
    if (existing.rows.length) {
      return res.json({ channelKey });
    }

    // Look up the AI name for this workspace
    const aiNameRes = await pool.query(
      `SELECT COALESCE(ai_name, 'AI Assistant') AS ai_name
       FROM workspace_ai_settings
       WHERE workspace_id = $1`,
      [workspaceId]
    );
    const aiName = aiNameRes.rows[0]?.ai_name || "AI Assistant";

    // Look up the AI system user for this workspace
    const aiUserRes = await pool.query(
      `SELECT user_id FROM system_users WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId]
    );
    const aiUserId = aiUserRes.rows[0]?.user_id;
    if (!aiUserId) {
      return res.status(500).json({ error: "AI system user not found for workspace" });
    }

    // Create the channel (AI user is creator, user is member, read-only via type)
    await pool.query(
      `INSERT INTO chat_channels (id, key, name, type, created_by, is_private, workspace_id, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'ai-notify', $3, true, $4, now())`,
      [channelKey, aiName, aiUserId, workspaceId]
    );

    // Add the user as a member (read-only — they can see but not post)
    const channelRes = await pool.query(
      `SELECT id FROM chat_channels WHERE key = $1`,
      [channelKey]
    );
    const channelId = channelRes.rows[0].id;

    await pool.query(
      `INSERT INTO chat_channel_members (id, channel_id, user_id)
       VALUES (gen_random_uuid(), $1, $2) ON CONFLICT DO NOTHING`,
      [channelId, userId]
    );

    return res.json({ channelKey });
  } catch (err) {
    console.error("[INTERNAL_ENSURE_NOTIFY_CHANNEL_ERROR]", err);
    return res.status(500).json({ error: "Failed to ensure notify channel" });
  }
});

/**
 * 🔒 Internal AI Memory Storage (WMDPE)
 * Stores opaque AI memory as JSON per workspace
 * Used ONLY by AI service
 */

// Save / update AI memory
router.post("/ai/memory", async (req, res) => {
  try {
    // 🔐 Shared-secret auth (same as other internal AI routes)
    const auth = req.headers.authorization || "";
    const token = auth.replace("Bearer ", "");

    if (token !== process.env.AI_SERVICE_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { workspaceId, type, payload } = req.body || {};

    if (!workspaceId || !type || payload === undefined) {
      return res.status(400).json({
        error: "workspaceId, type, payload are required",
      });
    }

    await pool.query(
      `
      INSERT INTO ai_memory (workspace_id, type, payload, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (workspace_id, type)
      DO UPDATE SET payload = $3, updated_at = NOW()
      `,
      [workspaceId, type, payload]
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("[INTERNAL_AI_MEMORY_SAVE_ERROR]", err);
    return res.status(500).json({ error: "Failed to save AI memory" });
  }
});

// Fetch all DM conversations for a specific user (used for away summary on disable)
router.get("/ai/conversations/:userId", async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.replace("Bearer ", "");
    if (token !== process.env.AI_SERVICE_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { userId } = req.params;
    const { workspaceId } = req.query;

    if (!userId || !workspaceId) {
      return res.status(400).json({ error: "userId and workspaceId required" });
    }

    const { rows } = await pool.query(
      `SELECT type, payload
       FROM ai_memory
       WHERE workspace_id = $1
         AND type LIKE 'dm_conv:%'
         AND payload->>'recipientId' = $2
         AND (payload->>'cleared' IS NULL OR payload->>'cleared' = 'false')`,
      [workspaceId, userId]
    );

    // Extract channelKey from type ("dm_conv:channelKey") and return
    const conversations = rows.map((r) => ({
      channelKey: r.type.replace("dm_conv:", ""),
      messages: r.payload?.messages || [],
      hasGreeted: r.payload?.hasGreeted || false,
    }));

    return res.json({ conversations });
  } catch (err) {
    console.error("[INTERNAL_AI_CONVERSATIONS_ERROR]", err);
    return res.status(500).json({ error: "Failed to fetch conversations" });
  }
});

// Read AI memory
router.get("/ai/memory", async (req, res) => {
  try {
    // 🔐 Shared-secret auth
    const auth = req.headers.authorization || "";
    const token = auth.replace("Bearer ", "");

    if (token !== process.env.AI_SERVICE_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { workspaceId, type } = req.query;

    if (!workspaceId || !type) {
      return res.status(400).json({
        error: "workspaceId and type are required",
      });
    }

    const { rows } = await pool.query(
      `
      SELECT payload
      FROM ai_memory
      WHERE workspace_id = $1 AND type = $2
      `,
      [workspaceId, type]
    );

    return res.json({
      payload: rows[0]?.payload || null,
    });
  } catch (err) {
    console.error("[INTERNAL_AI_MEMORY_READ_ERROR]", err);
    return res.status(500).json({ error: "Failed to read AI memory" });
  }
});

/**
 * 🔒 Internal: Read workspace chat history for AI (WMDPE)
 * Read-only, used ONLY by AI service
 */
router.get("/workspace-history/:workspaceId", async (req, res) => {
  try {
    // 🔐 Shared-secret auth
    const auth = req.headers.authorization || "";
    const token = auth.replace("Bearer ", "");

    if (token !== process.env.AI_SERVICE_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { workspaceId } = req.params;

    if (!workspaceId) {
      return res.status(400).json({ error: "workspaceId required" });
    }

    // 🔍 Read recent messages (limit for safety)
    const { rows } = await pool.query(
  `
  SELECT
  id,
  user_id,
  workspace_id,
  channel_key,
  created_at
FROM chat_messages
WHERE workspace_id = $1
ORDER BY created_at DESC
LIMIT 200
  `,
  [workspaceId]
);

    return res.json({
      messages: rows,
    });
  } catch (err) {
    console.error("[INTERNAL_WORKSPACE_HISTORY_ERROR]", err);
    return res.status(500).json({ error: "Failed to fetch workspace history" });
  }
});

/**
 * 🧠 Explain why AI replied to a message
 * Used by frontend (authenticated users)
 */
router.get("/ai/explain/:messageId", async (req, res) => {
  try {
    const { messageId } = req.params;
    const workspaceId = req.workspaceId || req.headers["x-workspace-id"];

    const { rows } = await pool.query(
      `
      SELECT explanation, confidence, model, context, created_at
      FROM ai_decision_provenance
      WHERE message_id = $1 AND workspace_id = $2
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [messageId, workspaceId]
    );

    if (!rows.length) {
  return res.json({
    available: false,
    pending: true, // 🔥 KEY FIX
  });
}

let parsed = null;
try {
  parsed =
    typeof rows[0].explanation === "string"
      ? JSON.parse(rows[0].explanation)
      : rows[0].explanation;
} catch {
  parsed = null;
}

if (!parsed) {
  return res.json({
    available: false,
    pending: false,
    error: "Explanation could not be parsed",
  });
}

return res.json({
  available: true,
  explanation: {
    summary: parsed.summary || "AI responded based on the user's message.",
    reasoning: parsed.reasoning || [],
    triggerMessage: parsed.triggerMessage || null,
    detectedIntent: parsed.detectedIntent || null,
  },
  confidence: rows[0].confidence,
  model: rows[0].model,
  context: rows[0].context,
  createdAt: rows[0].created_at,
});
  } catch (err) {
    return res.status(500).json({ available: false });
  }
});

router.post("/ai/provenance", async (req, res) => {
  try {
    const {
      workspaceId,
      messageId,
      channelKey,
      triggerMessageId,
      explanation,
      confidence,
      model,
      context,
    } = req.body;

    // 🔐 CRITICAL SAFETY FIX
    // If messageId is missing, skip provenance write
    if (!messageId) {
      console.warn(
        "[AI_PROVENANCE_SKIPPED] messageId missing, provenance not written"
      );
      return res.json({ ok: true, skipped: true });
    }

    await pool.query(
      `
      INSERT INTO ai_decision_provenance (
        workspace_id,
        message_id,
        channel_key,
        trigger_message_id,
        explanation,
        confidence,
        model,
        context
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `,
      [
        workspaceId,
        messageId,
        channelKey,
        triggerMessageId,
        explanation,
        confidence,
        model,
        context || {},
      ]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("[AI_PROVENANCE_WRITE_ERROR]", err);
    res.status(500).json({ error: "failed_to_record_ai_provenance" });
  }
});

/**
 * 🔒 Internal: Get a user's AI auto-reply preference
 * Called by AI service to check if recipient has opted in before replying
 */
router.get("/user-ai-preference/:userId", async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.replace("Bearer ", "");
    if (token !== process.env.AI_SERVICE_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { userId } = req.params;

    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.workspace_id, up.ai_reply_enabled
       FROM users u
       LEFT JOIN user_preferences up ON up.user_id = u.id
       WHERE u.id = $1
       LIMIT 1`,
      [userId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({
      userId: rows[0].id,
      username: rows[0].username,
      workspaceId: rows[0].workspace_id,
      ai_reply_enabled: rows[0].ai_reply_enabled ?? false, // default OFF
    });
  } catch (err) {
    console.error("[INTERNAL_USER_AI_PREF_ERROR]", err);
    res.status(500).json({ error: "Failed to fetch user AI preference" });
  }
});

/**
 * 🔒 Internal: Get away user's context for AI auto-reply
 * Returns projects, active tasks, overdue tasks so the AI can give informed answers
 * Called ONLY by AI service
 */
router.get("/user-context/:awayUserId", async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.replace("Bearer ", "");
    if (token !== process.env.AI_SERVICE_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { awayUserId } = req.params;
    const { workspaceId, projectIds } = req.query;

    if (!awayUserId || !workspaceId) {
      return res.status(400).json({ error: "awayUserId and workspaceId required" });
    }

    // Optional project filter — if provided, only return data from those projects
    // projectIds is a comma-separated list of UUIDs sent by the AI service
    const projectIdList = projectIds
      ? projectIds.split(",").map((id) => id.trim()).filter(Boolean)
      : null;

    // Build project filter clause (applies to all task queries when filter is set)
    const projectFilter = projectIdList?.length
      ? `AND t.project_id = ANY($3::uuid[])`
      : "";
    const taskParams = (base) =>
      projectIdList?.length ? [...base, projectIdList] : base;

    const [
      { rows: projects },
      { rows: activeTasks },
      { rows: overdueTasks },
      { rows: recentlyCompleted },
      { rows: createdTasks },
      { rows: taskActivity },
      { rows: attendanceRecent },
      { rows: attendanceEvents },
    ] = await Promise.all([
      // Projects (scoped to filter if provided, else all user's assigned projects)
      projectIdList?.length
        ? pool.query(
            `SELECT id, name FROM projects
             WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
            [workspaceId, projectIdList]
          )
        : pool.query(
            `SELECT DISTINCT p.id, p.name
             FROM projects p
             JOIN tasks t ON t.project_id = p.id
             WHERE p.workspace_id = $2 AND t.assigned_to = $1
             LIMIT 15`,
            [awayUserId, workspaceId]
          ),
      // Active assigned tasks (not overdue)
      pool.query(
        `SELECT t.id, t.task AS title, t.status, t.due_date, t.updated_at, p.name AS project_name
         FROM tasks t
         LEFT JOIN projects p ON p.id = t.project_id
         WHERE t.assigned_to = $1 AND t.workspace_id = $2
           AND t.status NOT IN ('completed', 'cancelled')
           AND (t.due_date IS NULL OR t.due_date >= CURRENT_DATE)
           ${projectFilter}
         ORDER BY t.due_date ASC NULLS LAST
         LIMIT 10`,
        taskParams([awayUserId, workspaceId])
      ),
      // Overdue assigned tasks
      pool.query(
        `SELECT t.id, t.task AS title, t.status, t.due_date, t.updated_at, p.name AS project_name
         FROM tasks t
         LEFT JOIN projects p ON p.id = t.project_id
         WHERE t.assigned_to = $1 AND t.workspace_id = $2
           AND t.status NOT IN ('completed', 'cancelled')
           AND t.due_date < CURRENT_DATE
           ${projectFilter}
         ORDER BY t.due_date ASC
         LIMIT 5`,
        taskParams([awayUserId, workspaceId])
      ),
      // Recently completed tasks (last 14 days)
      pool.query(
        `SELECT t.id, t.task AS title, t.status, t.due_date, t.updated_at, p.name AS project_name
         FROM tasks t
         LEFT JOIN projects p ON p.id = t.project_id
         WHERE t.assigned_to = $1 AND t.workspace_id = $2
           AND t.status = 'completed'
           AND t.updated_at >= NOW() - INTERVAL '14 days'
           ${projectFilter}
         ORDER BY t.updated_at DESC
         LIMIT 5`,
        taskParams([awayUserId, workspaceId])
      ),
      // Placeholder — createdTasks requires added_by column; returns empty for safety
      Promise.resolve({ rows: [] }),
      // Task activity logs — recent changes on this user's tasks (last 14 days)
      pool.query(
        `SELECT tal.action_type, tal.old_value, tal.new_value, tal.created_at,
                t.task AS task_title, u.username AS actor_name
         FROM task_activity_logs tal
         JOIN tasks t ON t.id = tal.task_id
         LEFT JOIN users u ON u.id = tal.actor_id
         WHERE t.assigned_to = $1 AND tal.workspace_id = $2
           AND tal.created_at >= NOW() - INTERVAL '14 days'
         ORDER BY tal.created_at DESC
         LIMIT 20`,
        [awayUserId, workspaceId]
      ),
      // Attendance: last 30 days from daily aggregates
      pool.query(
        `SELECT date, signed_in_minutes, available_minutes, aws_minutes, lunch_minutes
         FROM attendance_daily
         WHERE user_id = $1 AND workspace_id = $2
           AND date >= CURRENT_DATE - INTERVAL '30 days'
         ORDER BY date DESC
         LIMIT 14`,
        [awayUserId, workspaceId]
      ),
      // Attendance events: last sign-in per day (fallback if daily table is empty)
      pool.query(
        `SELECT date(started_at) AS date, max(started_at) AS last_event
         FROM attendance_events
         WHERE user_id = $1 AND workspace_id = $2
           AND event_type = 'SIGN_IN'
           AND started_at >= NOW() - INTERVAL '30 days'
         GROUP BY date(started_at)
         ORDER BY date DESC
         LIMIT 14`,
        [awayUserId, workspaceId]
      ),
    ]);

    return res.json({ projects, activeTasks, overdueTasks, recentlyCompleted, createdTasks, attendanceRecent, attendanceEvents, taskActivity });
  } catch (err) {
    console.error("[INTERNAL_USER_CONTEXT_ERROR]", err.message, err.stack?.split("\n")[1]);
    return res.status(500).json({ error: "Failed to fetch user context", detail: err.message });
  }
});

/**
 * 🔒 Internal: Check if two users are associated (share a project or task)
 * Used by AI auto-reply to decide whether data sharing is permitted
 * Called ONLY by AI service
 */
router.get("/association", async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.replace("Bearer ", "");
    if (token !== process.env.AI_SERVICE_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { awayUserId, askingUserId, workspaceId } = req.query;

    if (!awayUserId || !askingUserId || !workspaceId) {
      return res.status(400).json({ error: "awayUserId, askingUserId, workspaceId required" });
    }

    // Find projects where BOTH users have assigned tasks
    const { rows } = await pool.query(
      `SELECT p.id, p.name
       FROM projects p
       WHERE p.workspace_id = $3
         AND EXISTS (
           SELECT 1 FROM tasks
           WHERE assigned_to = $1 AND project_id = p.id
         )
         AND EXISTS (
           SELECT 1 FROM tasks
           WHERE assigned_to = $2 AND project_id = p.id
         )`,
      [awayUserId, askingUserId, workspaceId]
    );

    const associated = rows.length > 0;
    return res.json({
      associated,
      sharedProjects: rows,
      reason: associated ? "shared_project" : "none",
    });
  } catch (err) {
    console.error("[INTERNAL_ASSOCIATION_CHECK_ERROR]", err);
    return res.status(500).json({ error: "Association check failed" });
  }
});

/**
 * 🔒 Internal: Fetch project reports (used by frontend)
 */
router.get("/reports/project", async (req, res) => {
  try {
    const { workspaceId, projectName, fromDate, toDate } = req.query;

    if (!workspaceId || !projectName || !fromDate || !toDate) {
      return res.status(400).json({
        error: "workspaceId, projectName, fromDate, toDate are required",
      });
    }

    const from = new Date(fromDate);
const to = new Date(toDate);

if (isNaN(from.getTime()) || isNaN(to.getTime())) {
  return res.status(400).json({
    error: "invalid_dates",
    message: "Invalid date format",
  });
}

if (from > to) {
  return res.status(400).json({
    error: "invalid_date_range",
    message: "From date cannot be after To date",
  });
}

    const report = await getProjectReport({
      workspaceId,
      projectName,
      fromDate,
      toDate,
    });

    return res.json(report);
  } catch (err) {
    console.error("[REPORT_FETCH_ERROR]", err);
    return res.status(500).json({ error: "Failed to fetch report" });
  }
});

export default router;
