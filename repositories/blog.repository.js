// repositories/blog.repository.js
import pool from "../db.js";

const POST_COLUMN_LIST = [
  "id", "slug", "status", "title", "short_title", "dek", "category",
  "seo_title", "seo_description", "keywords", "takeaways", "sections", "sources",
  "related", "product_links", "reading_minutes", "featured",
  "author_workspace_id", "author_user_id", "author_superadmin_id", "author_display_name",
  "submitted_at", "submitted_by", "reviewed_at", "reviewed_by", "review_note",
  "published_at", "unpublished_at", "revision", "created_at", "updated_at",
];

const POST_COLUMNS = POST_COLUMN_LIST.join(", ");
const POST_COLUMNS_P = POST_COLUMN_LIST.map((column) => `p.${column}`).join(", ");

/** Columns a caller is allowed to set. Anything else in a payload is ignored. */
const EDITABLE_COLUMNS = [
  "slug",
  "title",
  "short_title",
  "dek",
  "category",
  "seo_title",
  "seo_description",
  "keywords",
  "takeaways",
  "sections",
  "sources",
  "related",
  "product_links",
  "reading_minutes",
  "featured",
];

const JSONB_COLUMNS = new Set(["takeaways", "sections", "sources"]);

function serialize(column, value) {
  return JSONB_COLUMNS.has(column) ? JSON.stringify(value ?? []) : value;
}

export async function listPublishedPosts({ limit = 200 } = {}) {
  const res = await pool.query(
    `SELECT ${POST_COLUMNS}
       FROM blog_posts
      WHERE status = 'published'
      ORDER BY published_at DESC
      LIMIT $1`,
    [limit]
  );
  return res.rows;
}

export async function getPublishedPostBySlug(slug) {
  const res = await pool.query(
    `SELECT ${POST_COLUMNS}
       FROM blog_posts
      WHERE slug = $1 AND status = 'published'`,
    [slug]
  );
  return res.rows[0] || null;
}

export async function getPostById(id) {
  const res = await pool.query(
    `SELECT ${POST_COLUMNS} FROM blog_posts WHERE id = $1`,
    [id]
  );
  return res.rows[0] || null;
}

export async function getPostBySlug(slug) {
  const res = await pool.query(
    `SELECT ${POST_COLUMNS} FROM blog_posts WHERE slug = $1`,
    [slug]
  );
  return res.rows[0] || null;
}

/** Posts authored inside one workspace. Never crosses a workspace boundary. */
export async function listWorkspacePosts(workspaceId, { status = null } = {}) {
  const params = [workspaceId];
  let filter = "";
  if (status) {
    params.push(status);
    filter = ` AND status = $${params.length}`;
  }
  const res = await pool.query(
    `SELECT ${POST_COLUMNS}
       FROM blog_posts
      WHERE author_workspace_id = $1${filter}
      ORDER BY updated_at DESC`,
    params
  );
  return res.rows;
}

/** Platform-wide list for the Super Admin console. */
export async function listAllPosts({ status = null, limit = 200 } = {}) {
  const params = [];
  let filter = "";
  if (status) {
    params.push(status);
    // Qualified: `workspaces` also has a `status` column, so a bare reference
    // would be ambiguous once the LEFT JOIN is in play.
    filter = ` WHERE p.status = $${params.length}`;
  }
  params.push(limit);

  const res = await pool.query(
    `SELECT ${POST_COLUMNS_P},
            w.name AS author_workspace_name,
            u.username AS author_username
       FROM blog_posts p
       LEFT JOIN workspaces w ON w.id = p.author_workspace_id
       LEFT JOIN users u ON u.id = p.author_user_id
       ${filter}
      ORDER BY
        CASE p.status WHEN 'in_review' THEN 0 ELSE 1 END,
        p.submitted_at DESC NULLS LAST,
        p.updated_at DESC
      LIMIT $${params.length}`,
    params
  );
  return res.rows;
}

export async function countByStatus() {
  const res = await pool.query(
    `SELECT status, COUNT(*)::int AS count FROM blog_posts GROUP BY status`
  );
  return Object.fromEntries(res.rows.map((row) => [row.status, row.count]));
}

export async function createPost(data) {
  const columns = [];
  const placeholders = [];
  const values = [];

  const payload = {
    ...data,
    // Authorship columns are set by the service, never by a request body.
    author_workspace_id: data.author_workspace_id ?? null,
    author_user_id: data.author_user_id ?? null,
    author_superadmin_id: data.author_superadmin_id ?? null,
    status: data.status || "draft",
  };

  for (const [column, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    columns.push(column);
    values.push(serialize(column, value));
    placeholders.push(`$${values.length}`);
  }

  const res = await pool.query(
    `INSERT INTO blog_posts (${columns.join(", ")})
     VALUES (${placeholders.join(", ")})
     RETURNING ${POST_COLUMNS}`,
    values
  );
  return res.rows[0];
}

/** Editorial update. Cannot change status, authorship, or review fields. */
export async function updatePostContent(id, data) {
  const assignments = [];
  const values = [];

  for (const column of EDITABLE_COLUMNS) {
    if (data[column] === undefined) continue;
    values.push(serialize(column, data[column]));
    assignments.push(`${column} = $${values.length}`);
  }

  if (!assignments.length) return getPostById(id);

  assignments.push("revision = revision + 1");
  values.push(id);

  const res = await pool.query(
    `UPDATE blog_posts SET ${assignments.join(", ")}
      WHERE id = $${values.length}
      RETURNING ${POST_COLUMNS}`,
    values
  );
  return res.rows[0] || null;
}

/**
 * Status transition guarded by the expected current status, so two concurrent
 * reviewers cannot both publish the same post.
 */
export async function transitionStatus(id, fromStatuses, toStatus, fields = {}) {
  const assignments = ["status = $1"];
  const values = [toStatus];

  for (const [column, value] of Object.entries(fields)) {
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  }

  values.push(id);
  const idPlaceholder = `$${values.length}`;
  values.push(fromStatuses);

  const res = await pool.query(
    `UPDATE blog_posts SET ${assignments.join(", ")}
      WHERE id = ${idPlaceholder} AND status = ANY($${values.length})
      RETURNING ${POST_COLUMNS}`,
    values
  );
  return res.rows[0] || null;
}

export async function deletePost(id) {
  const res = await pool.query(
    `DELETE FROM blog_posts WHERE id = $1 RETURNING id`,
    [id]
  );
  return res.rowCount > 0;
}

export async function recordEvent({
  post_id,
  action,
  from_status = null,
  to_status = null,
  actor_type,
  actor_user_id = null,
  actor_superadmin_id = null,
  note = null,
}) {
  const res = await pool.query(
    `INSERT INTO blog_post_events
       (post_id, action, from_status, to_status, actor_type, actor_user_id, actor_superadmin_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, created_at`,
    [post_id, action, from_status, to_status, actor_type, actor_user_id, actor_superadmin_id, note]
  );
  return res.rows[0];
}

export async function listEvents(postId) {
  const res = await pool.query(
    `SELECT e.id, e.action, e.from_status, e.to_status, e.actor_type,
            e.note, e.created_at,
            u.username AS actor_username,
            s.email AS actor_superadmin_email
       FROM blog_post_events e
       LEFT JOIN users u ON u.id = e.actor_user_id
       LEFT JOIN superadmins s ON s.id = e.actor_superadmin_id
      WHERE e.post_id = $1
      ORDER BY e.created_at DESC`,
    [postId]
  );
  return res.rows;
}

/** Slug availability check used before create and before slug edits. */
export async function slugExists(slug, excludePostId = null) {
  const res = await pool.query(
    `SELECT 1 FROM blog_posts WHERE slug = $1 AND ($2::uuid IS NULL OR id <> $2) LIMIT 1`,
    [slug, excludePostId]
  );
  return res.rowCount > 0;
}
