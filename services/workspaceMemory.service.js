import pool from "../db.js";

function normalizeTags(tags) {
  return Array.isArray(tags)
    ? tags.map((tag) => String(tag).trim()).filter(Boolean)
    : [];
}

function canAccessEntry(entry, userId, role) {
  if (!entry) return false;
  if (entry.visibility === "workspace") return true;
  if (String(entry.created_by) === String(userId)) return true;
  return role === "admin" || role === "owner" || role === "manager";
}

export async function listWorkspaceMemoryEntries({
  workspaceId,
  userId,
  role,
  q = "",
  includeArchived = false,
  limit = 50,
}) {
  const params = [workspaceId, userId];
  const conditions = [
    `m.workspace_id = $1`,
    `(m.visibility = 'workspace' OR m.created_by = $2)`,
  ];
  let idx = 3;

  if (!(role === "admin" || role === "owner" || role === "manager")) {
    conditions[1] = `(m.visibility = 'workspace' OR m.created_by = $2)`;
  }

  if (!includeArchived) {
    conditions.push(`m.is_archived = FALSE`);
  }

  if (q && String(q).trim()) {
    conditions.push(`(m.title ILIKE $${idx} OR m.content ILIKE $${idx})`);
    params.push(`%${String(q).trim()}%`);
    idx += 1;
  }

  params.push(Math.min(Math.max(Number(limit) || 50, 1), 100));

  const { rows } = await pool.query(
    `
    SELECT
      m.*,
      u.username AS created_by_name
    FROM workspace_memory_entries m
    LEFT JOIN users u ON u.id = m.created_by
    WHERE ${conditions.join(" AND ")}
    ORDER BY m.is_pinned DESC, m.updated_at DESC
    LIMIT $${idx}
    `,
    params
  );

  return rows;
}

export async function getWorkspaceMemoryEntry({ id, workspaceId, userId, role }) {
  const { rows } = await pool.query(
    `
    SELECT m.*, u.username AS created_by_name
    FROM workspace_memory_entries m
    LEFT JOIN users u ON u.id = m.created_by
    WHERE m.id = $1
      AND m.workspace_id = $2
    `,
    [id, workspaceId]
  );

  const entry = rows[0] || null;
  if (!canAccessEntry(entry, userId, role)) {
    return null;
  }
  return entry;
}

export async function createWorkspaceMemoryEntry({
  workspaceId,
  userId,
  role,
  title,
  content,
  tags = [],
  visibility = "workspace",
  sourceEntityType = null,
  sourceEntityId = null,
  metadata = {},
  isPinned = false,
}) {
  const safeVisibility = (role === "admin" || role === "owner" || role === "manager")
    ? (visibility === "private" ? "private" : "workspace")
    : "private";

  const { rows } = await pool.query(
    `
    INSERT INTO workspace_memory_entries (
      workspace_id,
      title,
      content,
      tags,
      visibility,
      created_by,
      source_entity_type,
      source_entity_id,
      metadata,
      is_pinned
    )
    VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9::jsonb,$10)
    RETURNING *
    `,
    [
      workspaceId,
      title,
      content,
      JSON.stringify(normalizeTags(tags)),
      safeVisibility,
      userId,
      sourceEntityType,
      sourceEntityId,
      JSON.stringify(metadata || {}),
      Boolean(isPinned) && (role === "admin" || role === "owner" || role === "manager"),
    ]
  );

  return rows[0];
}

export async function updateWorkspaceMemoryEntry({
  id,
  workspaceId,
  userId,
  role,
  patch,
}) {
  const existing = await getWorkspaceMemoryEntry({ id, workspaceId, userId, role });
  if (!existing) {
    throw new Error("Memory entry not found");
  }

  const isPrivileged = role === "admin" || role === "owner" || role === "manager";
  const isOwner = String(existing.created_by) === String(userId);
  if (!isPrivileged && !isOwner) {
    throw new Error("Forbidden");
  }

  const nextVisibility = isPrivileged
    ? (patch.visibility === "private" ? "private" : patch.visibility === "workspace" ? "workspace" : existing.visibility)
    : existing.visibility;

  const { rows } = await pool.query(
    `
    UPDATE workspace_memory_entries
    SET title = COALESCE($1, title),
        content = COALESCE($2, content),
        tags = COALESCE($3::jsonb, tags),
        visibility = $4,
        metadata = COALESCE($5::jsonb, metadata),
        is_pinned = $6,
        is_archived = COALESCE($7, is_archived),
        updated_at = NOW()
    WHERE id = $8
      AND workspace_id = $9
    RETURNING *
    `,
    [
      patch.title ?? null,
      patch.content ?? null,
      patch.tags ? JSON.stringify(normalizeTags(patch.tags)) : null,
      nextVisibility,
      patch.metadata ? JSON.stringify(patch.metadata) : null,
      isPrivileged ? Boolean(patch.isPinned ?? existing.is_pinned) : existing.is_pinned,
      patch.isArchived ?? null,
      id,
      workspaceId,
    ]
  );

  return rows[0];
}

export async function deleteWorkspaceMemoryEntry({ id, workspaceId, userId, role }) {
  const existing = await getWorkspaceMemoryEntry({ id, workspaceId, userId, role });
  if (!existing) {
    throw new Error("Memory entry not found");
  }

  const isPrivileged = role === "admin" || role === "owner" || role === "manager";
  const isOwner = String(existing.created_by) === String(userId);
  if (!isPrivileged && !isOwner) {
    throw new Error("Forbidden");
  }

  await pool.query(
    `DELETE FROM workspace_memory_entries WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId]
  );

  return { success: true };
}
