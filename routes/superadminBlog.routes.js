// routes/superadminBlog.routes.js
//
// The editorial console: the review queue for workspace submissions, plus
// first-party authoring. This is the only router that can set a post to
// `published`, and every route is behind requireSuperadmin.

import express from "express";
import requireSuperadmin from "../middleware/requireSuperadmin.js";
import {
  countByStatus,
  getPostById,
  listAllPosts,
  listEvents,
} from "../repositories/blog.repository.js";
import {
  BlogError,
  BLOG_CATEGORIES,
  createSuperadminPost,
  deleteAnyPost,
  publishPost,
  requestChanges,
  unpublishPost,
  updateAnyPost,
  validateForPublication,
} from "../services/blog.service.js";
import { getPublishStamp } from "../services/blogCache.service.js";

const router = express.Router();
router.use(requireSuperadmin);

function fail(res, err, context) {
  if (err instanceof BlogError) {
    return res.status(err.statusCode).json({ error: err.message, details: err.details });
  }
  console.error(`[superadmin-blog] ${context}:`, err.message);
  return res.status(500).json({ error: "Something went wrong" });
}

/** Reviewer view: full editorial payload plus provenance. */
function toReviewPost(row) {
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

    origin: row.author_superadmin_id ? "platform" : "workspace",
    author_workspace_id: row.author_workspace_id,
    author_workspace_name: row.author_workspace_name || null,
    author_username: row.author_username || null,

    review_note: row.review_note,
    submitted_at: row.submitted_at,
    reviewed_at: row.reviewed_at,
    published_at: row.published_at,
    unpublished_at: row.unpublished_at,
    revision: row.revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
    public_url: row.status === "published" ? `/blog/${row.slug}` : null,
  };
}

/** GET /superadmin/blog/categories */
router.get("/categories", (_req, res) => res.json({ categories: BLOG_CATEGORIES }));

/**
 * GET /superadmin/blog/queue
 * Counts for the console badge. `pending` is what needs a decision.
 */
router.get("/queue", async (_req, res) => {
  try {
    const counts = await countByStatus();
    return res.json({
      pending: counts.in_review || 0,
      counts,
      stamp: getPublishStamp(),
    });
  } catch (err) {
    return fail(res, err, "queue failed");
  }
});

/**
 * GET /superadmin/blog?status=in_review
 * Platform-wide list. Submissions awaiting review sort to the top.
 */
router.get("/", async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status) : null;
    const rows = await listAllPosts({ status });
    return res.json({ posts: rows.map(toReviewPost) });
  } catch (err) {
    return fail(res, err, "list failed");
  }
});

/** POST /superadmin/blog — author directly. Pass { publish: true } to go live now. */
router.post("/", async (req, res) => {
  try {
    const post = await createSuperadminPost({
      superadminId: req.superadmin.id,
      body: req.body || {},
      publish: Boolean(req.body?.publish),
    });
    return res.status(201).json(toReviewPost(post));
  } catch (err) {
    return fail(res, err, "create failed");
  }
});

/** GET /superadmin/blog/:id — one post with its readiness report and history. */
router.get("/:id", async (req, res) => {
  try {
    const post = await getPostById(req.params.id);
    if (!post) return res.status(404).json({ error: "Post not found" });
    return res.json({
      ...toReviewPost(post),
      readiness: validateForPublication(post),
      history: await listEvents(post.id),
    });
  } catch (err) {
    return fail(res, err, "read failed");
  }
});

/** PUT /superadmin/blog/:id — edit any post, at any status. */
router.put("/:id", async (req, res) => {
  try {
    const post = await updateAnyPost({
      id: req.params.id,
      superadminId: req.superadmin.id,
      body: req.body || {},
    });
    return res.json({ ...toReviewPost(post), readiness: validateForPublication(post) });
  } catch (err) {
    return fail(res, err, "update failed");
  }
});

/**
 * POST /superadmin/blog/:id/publish
 * Approves a submission, or pushes a first-party draft live. The edge cache is
 * purged before this returns, so the article is reachable immediately.
 */
router.post("/:id/publish", async (req, res) => {
  try {
    const post = await publishPost({
      id: req.params.id,
      superadminId: req.superadmin.id,
      note: req.body?.note || null,
    });
    return res.json({ ...toReviewPost(post), message: "Published" });
  } catch (err) {
    return fail(res, err, "publish failed");
  }
});

/** POST /superadmin/blog/:id/request-changes — return a submission to its author. */
router.post("/:id/request-changes", async (req, res) => {
  try {
    const post = await requestChanges({
      id: req.params.id,
      superadminId: req.superadmin.id,
      note: req.body?.note,
    });
    return res.json({ ...toReviewPost(post), message: "Returned to author" });
  } catch (err) {
    return fail(res, err, "request-changes failed");
  }
});

/** POST /superadmin/blog/:id/unpublish — take a live post down. */
router.post("/:id/unpublish", async (req, res) => {
  try {
    const post = await unpublishPost({
      id: req.params.id,
      superadminId: req.superadmin.id,
      note: req.body?.note || null,
    });
    return res.json({ ...toReviewPost(post), message: "Unpublished" });
  } catch (err) {
    return fail(res, err, "unpublish failed");
  }
});

/** DELETE /superadmin/blog/:id */
router.delete("/:id", async (req, res) => {
  try {
    await deleteAnyPost({ id: req.params.id, superadminId: req.superadmin.id });
    return res.json({ success: true });
  } catch (err) {
    return fail(res, err, "delete failed");
  }
});

export default router;
