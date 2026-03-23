// routes/wiki.routes.js
import express from "express";
import db from "../db.js";
import { logAudit } from "../services/audit.service.js";

const router = express.Router();

// ─── SPACES ───────────────────────────────────────────────────────────────────

router.get("/spaces", async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT ws.*, u.username AS created_by_name,
              (SELECT COUNT(*) FROM wiki_pages WHERE space_id = ws.id) AS page_count
       FROM wiki_spaces ws
       LEFT JOIN users u ON u.id = ws.created_by
       WHERE ws.workspace_id = $1
       ORDER BY ws.name ASC`,
      [req.workspaceId]
    );
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/spaces", async (req, res) => {
  try {
    const { name, slug, icon, is_private = false } = req.body;
    if (!name || !slug) return res.status(400).json({ error: "name and slug are required" });

    const row = await db.query(
      `INSERT INTO wiki_spaces (workspace_id, name, slug, icon, is_private, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.workspaceId, name, slug.toLowerCase().replace(/\s+/g, "-"), icon || "📄", is_private, req.user.id]
    );
    await logAudit({ workspaceId: req.workspaceId, userId: req.user.id, action: "wiki.space.create", entityType: "wiki_space", entityId: row.rows[0].id });
    res.status(201).json(row.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/spaces/:spaceId", async (req, res) => {
  try {
    if (!["admin", "owner"].includes(req.user.role)) return res.status(403).json({ error: "Admin required" });
    await db.query("DELETE FROM wiki_spaces WHERE id = $1 AND workspace_id = $2", [req.params.spaceId, req.workspaceId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PAGES ────────────────────────────────────────────────────────────────────

/** List pages in a space (tree structure) */
router.get("/spaces/:spaceId/pages", async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT p.id, p.parent_id, p.title, p.slug, p.icon, p.position, p.is_published,
              p.created_at, p.updated_at,
              u1.username AS created_by_name, u2.username AS updated_by_name
       FROM wiki_pages p
       LEFT JOIN users u1 ON u1.id = p.created_by
       LEFT JOIN users u2 ON u2.id = p.updated_by
       WHERE p.space_id = $1
       ORDER BY p.position ASC, p.created_at ASC`,
      [req.params.spaceId]
    );
    // Build tree
    const pages = rows.rows;
    const map = {};
    pages.forEach(p => { map[p.id] = { ...p, children: [] }; });
    const roots = [];
    pages.forEach(p => {
      if (p.parent_id && map[p.parent_id]) {
        map[p.parent_id].children.push(map[p.id]);
      } else {
        roots.push(map[p.id]);
      }
    });
    res.json(roots);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Get a single page with content */
router.get("/pages/:pageId", async (req, res) => {
  try {
    const row = await db.query(
      `SELECT p.*, ws.workspace_id,
              u1.username AS created_by_name, u2.username AS updated_by_name
       FROM wiki_pages p
       JOIN wiki_spaces ws ON ws.id = p.space_id
       LEFT JOIN users u1 ON u1.id = p.created_by
       LEFT JOIN users u2 ON u2.id = p.updated_by
       WHERE p.id = $1 AND ws.workspace_id = $2`,
      [req.params.pageId, req.workspaceId]
    );
    if (!row.rows[0]) return res.status(404).json({ error: "Page not found" });
    res.json(row.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Create page */
router.post("/spaces/:spaceId/pages", async (req, res) => {
  try {
    const { title, slug, content = "", content_text = "", icon, parent_id, position = 0 } = req.body;
    if (!title) return res.status(400).json({ error: "title is required" });

    const pageSlug = slug || title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

    const row = await db.query(
      `INSERT INTO wiki_pages
         (space_id, parent_id, title, slug, content, content_text, icon, position, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,
      [req.params.spaceId, parent_id || null, title, pageSlug, content, content_text, icon || null, position, req.user.id]
    );

    await logAudit({ workspaceId: req.workspaceId, userId: req.user.id, action: "wiki.page.create", entityType: "wiki_page", entityId: row.rows[0].id, newValue: { title } });
    res.status(201).json(row.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Update page */
router.put("/pages/:pageId", async (req, res) => {
  try {
    const { title, content, content_text, icon, parent_id, position, is_published } = req.body;

    // Save version before update
    const existing = await db.query("SELECT * FROM wiki_pages WHERE id = $1", [req.params.pageId]);
    if (!existing.rows[0]) return res.status(404).json({ error: "Page not found" });

    const prev = existing.rows[0];
    const maxVersionRow = await db.query("SELECT MAX(version) AS v FROM wiki_page_versions WHERE page_id = $1", [req.params.pageId]);
    const nextVersion = (maxVersionRow.rows[0].v || 0) + 1;

    await db.query(
      "INSERT INTO wiki_page_versions (page_id, content, title, version, edited_by) VALUES ($1,$2,$3,$4,$5)",
      [req.params.pageId, prev.content, prev.title, nextVersion, req.user.id]
    );

    const row = await db.query(
      `UPDATE wiki_pages SET
         title        = COALESCE($1, title),
         content      = COALESCE($2, content),
         content_text = COALESCE($3, content_text),
         icon         = COALESCE($4, icon),
         parent_id    = $5,
         position     = COALESCE($6, position),
         is_published = COALESCE($7, is_published),
         updated_by   = $8,
         updated_at   = NOW()
       WHERE id = $9 RETURNING *`,
      [title, content, content_text, icon, parent_id ?? prev.parent_id, position, is_published, req.user.id, req.params.pageId]
    );

    res.json(row.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Delete page */
router.delete("/pages/:pageId", async (req, res) => {
  try {
    await db.query("DELETE FROM wiki_pages WHERE id = $1", [req.params.pageId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Full-text search */
router.get("/search", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json([]);

    const rows = await db.query(
      `SELECT p.id, p.title, p.slug, p.space_id, ws.name AS space_name,
              ts_headline('english', p.content_text, plainto_tsquery($1), 'MaxFragments=1,MaxWords=15,MinWords=5') AS excerpt
       FROM wiki_pages p
       JOIN wiki_spaces ws ON ws.id = p.space_id
       WHERE ws.workspace_id = $2
         AND to_tsvector('english', p.content_text) @@ plainto_tsquery($1)
       LIMIT 20`,
      [q, req.workspaceId]
    );
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Page version history */
router.get("/pages/:pageId/versions", async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT pv.*, u.username AS edited_by_name
       FROM wiki_page_versions pv
       LEFT JOIN users u ON u.id = pv.edited_by
       WHERE pv.page_id = $1
       ORDER BY pv.version DESC
       LIMIT 20`,
      [req.params.pageId]
    );
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
