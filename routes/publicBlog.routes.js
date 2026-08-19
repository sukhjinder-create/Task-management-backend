// routes/publicBlog.routes.js
//
// The read side of Asystence Insights. Unauthenticated by design: the landing
// site's /blog renderer is the only real consumer. Every row here is
// `status = 'published'`, projected through toPublicPost so no workspace
// origin, author identity, or review note can escape.

import express from "express";
import crypto from "node:crypto";
import { listPublishedPosts, getPublishedPostBySlug } from "../repositories/blog.repository.js";
import { toPublicPost } from "../services/blog.service.js";
import { getPublishStamp } from "../services/blogCache.service.js";

const router = express.Router();

// Short enough that a publish is live within a minute even if the purge
// webhook is not configured; long enough that crawlers never stampede the DB.
const CACHE_CONTROL = "public, max-age=0, s-maxage=60, stale-while-revalidate=600";

function withCacheHeaders(res, payload) {
  const etag = `W/"blog-${getPublishStamp()}-${crypto
    .createHash("sha1")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 16)}"`;
  res.set("Cache-Control", CACHE_CONTROL);
  res.set("ETag", etag);
  return etag;
}

/**
 * GET /public/blog/posts
 * Every published article, newest first. The landing index and the sitemap
 * and RSS builders all read this one endpoint.
 */
router.get("/posts", async (req, res) => {
  try {
    const rows = await listPublishedPosts();
    const payload = {
      stamp: getPublishStamp(),
      count: rows.length,
      posts: rows.map(toPublicPost),
    };

    const etag = withCacheHeaders(res, payload);
    if (req.headers["if-none-match"] === etag) return res.status(304).end();

    return res.json(payload);
  } catch (err) {
    console.error("[public-blog] failed to list posts:", err.message);
    return res.status(500).json({ error: "Posts are temporarily unavailable" });
  }
});

/**
 * GET /public/blog/posts/:slug
 * One published article. 404 for drafts and archived posts alike, so an
 * unpublished slug is indistinguishable from one that never existed.
 */
router.get("/posts/:slug", async (req, res) => {
  try {
    const row = await getPublishedPostBySlug(String(req.params.slug || "").toLowerCase());
    if (!row) return res.status(404).json({ error: "Post not found" });

    const payload = { stamp: getPublishStamp(), post: toPublicPost(row) };

    const etag = withCacheHeaders(res, payload);
    if (req.headers["if-none-match"] === etag) return res.status(304).end();

    return res.json(payload);
  } catch (err) {
    console.error("[public-blog] failed to load post:", err.message);
    return res.status(500).json({ error: "Post is temporarily unavailable" });
  }
});

export default router;
