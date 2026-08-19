// services/blogCache.service.js
//
// Publishing must reach readers without a rebuild, so the landing site renders
// /blog from this API and caches the result at the edge. That leaves one job
// here: tell the edge to drop what it holds the moment a post changes.
//
// Two layers, deliberately:
//
//   1. A monotonic publish stamp exposed on the public API. The landing
//      function sends `s-maxage=60, stale-while-revalidate=600`, so even with
//      no purge configured a publish is live within a minute and a stale
//      reader never waits on the backend.
//
//   2. An optional purge webhook (BLOG_REVALIDATE_URL). When configured, a
//      publish is live immediately. This is best-effort by design: a purge
//      failure must never fail or roll back a publish that already committed.

const REVALIDATE_URL = process.env.BLOG_REVALIDATE_URL?.trim() || "";
const REVALIDATE_SECRET = process.env.BLOG_REVALIDATE_SECRET?.trim() || "";
const REVALIDATE_TIMEOUT_MS = 4000;

/**
 * Bumped on every publish, unpublish, or edit to a live post. The public API
 * returns it as an ETag input so an unchanged blog stays a cheap 304.
 */
let publishStamp = Date.now();

export function getPublishStamp() {
  return publishStamp;
}

export function bumpPublishStamp() {
  // Guard against a clock that has not advanced between two rapid publishes.
  publishStamp = Math.max(Date.now(), publishStamp + 1);
  return publishStamp;
}

/**
 * Invalidate the edge copy of the blog index and, when given, one article.
 * Always resolves — callers treat this as fire-and-forget.
 */
export async function purgePublishedBlogCache(slug = null) {
  bumpPublishStamp();

  if (!REVALIDATE_URL) return { purged: false, reason: "not_configured" };

  const paths = slug ? ["/blog", `/blog/${slug}`] : ["/blog"];

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REVALIDATE_TIMEOUT_MS);

    const response = await fetch(REVALIDATE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(REVALIDATE_SECRET ? { "X-Revalidate-Secret": REVALIDATE_SECRET } : {}),
      },
      body: JSON.stringify({ paths, stamp: publishStamp }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    if (!response.ok) {
      console.warn(`[blog-cache] purge returned ${response.status} for ${paths.join(", ")}`);
      return { purged: false, reason: `http_${response.status}` };
    }
    return { purged: true, paths };
  } catch (error) {
    // The 60s TTL is the backstop; a failed purge only delays visibility.
    console.warn("[blog-cache] purge failed:", error.message);
    return { purged: false, reason: error.name === "AbortError" ? "timeout" : "error" };
  }
}

export default { getPublishStamp, bumpPublishStamp, purgePublishedBlogCache };
