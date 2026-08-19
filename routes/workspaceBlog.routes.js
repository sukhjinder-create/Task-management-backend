// routes/workspaceBlog.routes.js
//
// The workspace-admin authoring surface. Mounted behind authMiddleware +
// requireWorkspaceForUser + allowRoles("admin"), so every handler here can
// assume req.workspaceId is a real workspace and the caller administers it.
//
// Nothing in this file can publish. The furthest a workspace admin can move a
// post is `in_review`; only routes/superadminBlog.routes.js goes further.

import express from "express";
import {
  listWorkspacePosts,
  listEvents,
  getPostById,
} from "../repositories/blog.repository.js";
import {
  BlogError,
  BLOG_CATEGORIES,
  createWorkspaceDraft,
  deleteWorkspacePost,
  submitForReview,
  updateWorkspacePost,
  validateForPublication,
  withdrawFromReview,
} from "../services/blog.service.js";

const router = express.Router();

function fail(res, err, context) {
  if (err instanceof BlogError) {
    return res.status(err.statusCode).json({ error: err.message, details: err.details });
  }
  console.error(`[workspace-blog] ${context}:`, err.message);
  return res.status(500).json({ error: "Something went wrong" });
}

/** Author-facing view. Includes review feedback the public projection hides. */
function toAuthorPost(row) {
  return {
    id: row.id,
    slug: row.slug,
    status: row.status,
    title: row.title,
    short_title: row.short_title,
    dek: row.dek,
    category: row.category,
    seo_title: row.seo_title,
    seo_description: row.seo_description,
    keywords: row.keywords || [],
    takeaways: row.takeaways || [],
    sections: row.sections || [],
    sources: row.sources || [],
    related: row.related || [],
    product_links: row.product_links || [],
    reading_minutes: row.reading_minutes,
    featured: row.featured,
    review_note: row.review_note,
    submitted_at: row.submitted_at,
    reviewed_at: row.reviewed_at,
    published_at: row.published_at,
    revision: row.revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
    public_url: row.status === "published" ? `/blog/${row.slug}` : null,
  };
}

/** GET /blog/categories — the fixed editorial taxonomy. */
router.get("/categories", (_req, res) => res.json({ categories: BLOG_CATEGORIES }));

/** GET /blog — this workspace's posts. */
router.get("/", async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status) : null;
    const rows = await listWorkspacePosts(req.workspaceId, { status });
    return res.json({ posts: rows.map(toAuthorPost) });
  } catch (err) {
    return fail(res, err, "list failed");
  }
});

/** POST /blog — start a draft. */
router.post("/", async (req, res) => {
  try {
    const post = await createWorkspaceDraft({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      body: req.body || {},
    });
    return res.status(201).json(toAuthorPost(post));
  } catch (err) {
    return fail(res, err, "create failed");
  }
});

/** GET /blog/:id — one post, scoped to this workspace. */
router.get("/:id", async (req, res) => {
  try {
    const post = await getPostById(req.params.id);
    if (!post || post.author_workspace_id !== req.workspaceId) {
      return res.status(404).json({ error: "Post not found" });
    }
    return res.json({
      ...toAuthorPost(post),
      readiness: validateForPublication(post),
      history: await listEvents(post.id),
    });
  } catch (err) {
    return fail(res, err, "read failed");
  }
});

/** PUT /blog/:id — edit a draft or a returned post. */
router.put("/:id", async (req, res) => {
  try {
    const post = await updateWorkspacePost({
      id: req.params.id,
      workspaceId: req.workspaceId,
      userId: req.user.id,
      body: req.body || {},
    });
    return res.json({ ...toAuthorPost(post), readiness: validateForPublication(post) });
  } catch (err) {
    return fail(res, err, "update failed");
  }
});

/**
 * POST /blog/:id/submit — request publication.
 * Returns 422 with a `details` list when the post is not yet complete, so the
 * author sees exactly what is missing rather than a generic rejection.
 */
router.post("/:id/submit", async (req, res) => {
  try {
    const post = await submitForReview({
      id: req.params.id,
      workspaceId: req.workspaceId,
      userId: req.user.id,
    });
    return res.json({
      ...toAuthorPost(post),
      message: "Submitted for Super Admin review",
    });
  } catch (err) {
    return fail(res, err, "submit failed");
  }
});

/** POST /blog/:id/withdraw — pull a submission back for more editing. */
router.post("/:id/withdraw", async (req, res) => {
  try {
    const post = await withdrawFromReview({
      id: req.params.id,
      workspaceId: req.workspaceId,
      userId: req.user.id,
    });
    return res.json(toAuthorPost(post));
  } catch (err) {
    return fail(res, err, "withdraw failed");
  }
});

/** DELETE /blog/:id — remove an unpublished post. */
router.delete("/:id", async (req, res) => {
  try {
    await deleteWorkspacePost({
      id: req.params.id,
      workspaceId: req.workspaceId,
      userId: req.user.id,
    });
    return res.json({ success: true });
  } catch (err) {
    return fail(res, err, "delete failed");
  }
});

export default router;
