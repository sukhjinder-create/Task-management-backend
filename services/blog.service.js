// services/blog.service.js
//
// The Asystence Insights editorial pipeline.
//
// Two authoring surfaces converge on one review queue:
//   workspace admin: draft -> in_review -> (published | changes_requested)
//   super admin:     draft -> published directly, and owns every review decision
//
// Only `publishPost` and `unpublishPost` change what the public sees, and both
// are reachable exclusively through requireSuperadmin-guarded routes.

import * as repo from "../repositories/blog.repository.js";
import { notifyUser } from "./notification.service.js";
import { purgePublishedBlogCache } from "./blogCache.service.js";
import {
  PUBLIC_AUTHOR_NAME,
  normalizePayload,
  slugify,
  validateForPublication,
} from "./blogContent.js";

// Re-exported so routes and tests have one import surface for the feature.
export {
  BLOG_CATEGORIES,
  PUBLIC_AUTHOR_NAME,
  countWords,
  normalizePayload,
  slugify,
  toPublicPost,
  validateForPublication,
} from "./blogContent.js";

export class BlogError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function assertPublishable(post) {
  const problems = validateForPublication(post);
  if (problems.length) {
    const error = new BlogError("Post is not ready for publication", 422);
    error.details = problems;
    throw error;
  }
}

async function ensureSlug(candidate, title, excludePostId = null) {
  let slug = slugify(candidate || title);
  if (!slug) throw new BlogError("A title or slug is required");

  // Append a counter rather than rejecting, so two workspaces writing about the
  // same topic do not block each other.
  let attempt = slug;
  let suffix = 2;
  while (await repo.slugExists(attempt, excludePostId)) {
    attempt = `${slug}-${suffix++}`;
    if (suffix > 50) throw new BlogError("Could not derive a unique slug", 409);
  }
  return attempt;
}

// ─────────────────────────────
// Workspace-admin operations
// ─────────────────────────────

export async function createWorkspaceDraft({ workspaceId, userId, body }) {
  if (!workspaceId) throw new BlogError("Workspace context is required", 403);

  const payload = normalizePayload(body);
  if (!payload.title) throw new BlogError("A title is required");

  const slug = await ensureSlug(body.slug, payload.title);
  const post = await repo.createPost({
    ...payload,
    slug,
    status: "draft",
    author_workspace_id: workspaceId,
    author_user_id: userId,
    author_display_name: PUBLIC_AUTHOR_NAME,
  });

  await repo.recordEvent({
    post_id: post.id,
    action: "created",
    to_status: "draft",
    actor_type: "workspace_admin",
    actor_user_id: userId,
  });

  return post;
}

/** Loads a post and proves it belongs to the caller's workspace. */
async function loadWorkspacePost(id, workspaceId) {
  const post = await repo.getPostById(id);
  // A 404 for both "missing" and "someone else's" so the endpoint cannot be
  // used to probe which slugs exist in other workspaces.
  if (!post || post.author_workspace_id !== workspaceId) {
    throw new BlogError("Post not found", 404);
  }
  return post;
}

const WORKSPACE_EDITABLE_STATUSES = new Set(["draft", "changes_requested"]);

export async function updateWorkspacePost({ id, workspaceId, userId, body }) {
  const post = await loadWorkspacePost(id, workspaceId);

  if (!WORKSPACE_EDITABLE_STATUSES.has(post.status)) {
    throw new BlogError(
      post.status === "published"
        ? "Published posts can only be edited by a Super Admin"
        : "This post is in review and cannot be edited until it is withdrawn",
      409
    );
  }

  const payload = normalizePayload(body, { partial: true });
  if (payload.slug && payload.slug !== post.slug) {
    payload.slug = await ensureSlug(payload.slug, post.title, post.id);
  }

  const updated = await repo.updatePostContent(id, payload);
  await repo.recordEvent({
    post_id: id,
    action: "updated",
    from_status: post.status,
    to_status: post.status,
    actor_type: "workspace_admin",
    actor_user_id: userId,
  });
  return updated;
}

export async function submitForReview({ id, workspaceId, userId }) {
  const post = await loadWorkspacePost(id, workspaceId);

  if (post.status === "in_review") throw new BlogError("This post is already awaiting review", 409);
  if (!WORKSPACE_EDITABLE_STATUSES.has(post.status)) {
    throw new BlogError("Only a draft can be submitted for review", 409);
  }

  assertPublishable(post);

  const updated = await repo.transitionStatus(
    id,
    ["draft", "changes_requested"],
    "in_review",
    { submitted_at: new Date(), submitted_by: userId, review_note: null }
  );
  if (!updated) throw new BlogError("This post changed while you were submitting it", 409);

  await repo.recordEvent({
    post_id: id,
    action: "submitted",
    from_status: post.status,
    to_status: "in_review",
    actor_type: "workspace_admin",
    actor_user_id: userId,
  });

  return updated;
}

export async function withdrawFromReview({ id, workspaceId, userId }) {
  const post = await loadWorkspacePost(id, workspaceId);
  if (post.status !== "in_review") throw new BlogError("Only a post in review can be withdrawn", 409);

  const updated = await repo.transitionStatus(id, ["in_review"], "draft", {
    submitted_at: null,
    submitted_by: null,
  });
  if (!updated) throw new BlogError("This post was already reviewed", 409);

  await repo.recordEvent({
    post_id: id,
    action: "withdrawn",
    from_status: "in_review",
    to_status: "draft",
    actor_type: "workspace_admin",
    actor_user_id: userId,
  });
  return updated;
}

export async function deleteWorkspacePost({ id, workspaceId, userId }) {
  const post = await loadWorkspacePost(id, workspaceId);
  if (post.status === "published") {
    throw new BlogError("A published post can only be removed by a Super Admin", 409);
  }
  await repo.recordEvent({
    post_id: id,
    action: "deleted",
    from_status: post.status,
    actor_type: "workspace_admin",
    actor_user_id: userId,
  });
  await repo.deletePost(id);
  return true;
}

// ─────────────────────────────
// Super-admin operations
// ─────────────────────────────

export async function createSuperadminPost({ superadminId, body, publish = false }) {
  const payload = normalizePayload(body);
  if (!payload.title) throw new BlogError("A title is required");

  const slug = await ensureSlug(body.slug, payload.title);
  const draft = {
    ...payload,
    slug,
    status: "draft",
    author_superadmin_id: superadminId,
    author_display_name: PUBLIC_AUTHOR_NAME,
  };

  if (publish) {
    assertPublishable({ ...draft, ...payload });
    draft.status = "published";
    draft.published_at = new Date();
    draft.reviewed_at = new Date();
    draft.reviewed_by = superadminId;
  }

  const post = await repo.createPost(draft);
  await repo.recordEvent({
    post_id: post.id,
    action: publish ? "published" : "created",
    to_status: post.status,
    actor_type: "superadmin",
    actor_superadmin_id: superadminId,
  });

  if (publish) await purgePublishedBlogCache(post.slug);
  return post;
}

export async function updateAnyPost({ id, superadminId, body }) {
  const post = await repo.getPostById(id);
  if (!post) throw new BlogError("Post not found", 404);

  const payload = normalizePayload(body, { partial: true });
  if (payload.slug && payload.slug !== post.slug) {
    payload.slug = await ensureSlug(payload.slug, post.title, post.id);
  }

  const updated = await repo.updatePostContent(id, payload);
  await repo.recordEvent({
    post_id: id,
    action: "updated",
    from_status: post.status,
    to_status: post.status,
    actor_type: "superadmin",
    actor_superadmin_id: superadminId,
  });

  // An edit to a live post must reach readers without waiting for the TTL.
  if (post.status === "published") {
    await purgePublishedBlogCache(updated.slug);
    if (updated.slug !== post.slug) await purgePublishedBlogCache(post.slug);
  }
  return updated;
}

export async function publishPost({ id, superadminId, note = null }) {
  const post = await repo.getPostById(id);
  if (!post) throw new BlogError("Post not found", 404);
  if (post.status === "published") throw new BlogError("This post is already published", 409);

  assertPublishable(post);

  const updated = await repo.transitionStatus(
    id,
    ["draft", "in_review", "changes_requested", "archived"],
    "published",
    {
      published_at: post.published_at || new Date(),
      unpublished_at: null,
      reviewed_at: new Date(),
      reviewed_by: superadminId,
      review_note: note,
    }
  );
  if (!updated) throw new BlogError("This post changed while you were publishing it", 409);

  await repo.recordEvent({
    post_id: id,
    action: "published",
    from_status: post.status,
    to_status: "published",
    actor_type: "superadmin",
    actor_superadmin_id: superadminId,
    note,
  });

  await notifyAuthor(post, {
    type: "blog_published",
    title: "Your article is live",
    message: `“${post.title}” has been published to Asystence Insights.`,
    action_url: `/blog/${updated.slug}`,
  });

  await purgePublishedBlogCache(updated.slug);
  return updated;
}

export async function requestChanges({ id, superadminId, note }) {
  const post = await repo.getPostById(id);
  if (!post) throw new BlogError("Post not found", 404);
  if (post.status !== "in_review") {
    throw new BlogError("Only a post awaiting review can be returned to its author", 409);
  }
  const trimmed = String(note || "").trim();
  if (!trimmed) throw new BlogError("A note explaining the requested changes is required");

  const updated = await repo.transitionStatus(id, ["in_review"], "changes_requested", {
    reviewed_at: new Date(),
    reviewed_by: superadminId,
    review_note: trimmed,
  });
  if (!updated) throw new BlogError("This post changed while you were reviewing it", 409);

  await repo.recordEvent({
    post_id: id,
    action: "changes_requested",
    from_status: "in_review",
    to_status: "changes_requested",
    actor_type: "superadmin",
    actor_superadmin_id: superadminId,
    note: trimmed,
  });

  await notifyAuthor(post, {
    type: "blog_changes_requested",
    title: "Changes requested on your article",
    message: `“${post.title}” needs revisions before it can be published.`,
    action_url: "/workspace-blog",
  });

  return updated;
}

export async function unpublishPost({ id, superadminId, note = null }) {
  const post = await repo.getPostById(id);
  if (!post) throw new BlogError("Post not found", 404);
  if (post.status !== "published") throw new BlogError("This post is not published", 409);

  const updated = await repo.transitionStatus(id, ["published"], "archived", {
    unpublished_at: new Date(),
    reviewed_at: new Date(),
    reviewed_by: superadminId,
    review_note: note,
  });
  if (!updated) throw new BlogError("This post changed while you were unpublishing it", 409);

  await repo.recordEvent({
    post_id: id,
    action: "unpublished",
    from_status: "published",
    to_status: "archived",
    actor_type: "superadmin",
    actor_superadmin_id: superadminId,
    note,
  });

  await purgePublishedBlogCache(updated.slug);
  return updated;
}

export async function deleteAnyPost({ id, superadminId }) {
  const post = await repo.getPostById(id);
  if (!post) throw new BlogError("Post not found", 404);

  await repo.recordEvent({
    post_id: id,
    action: "deleted",
    from_status: post.status,
    actor_type: "superadmin",
    actor_superadmin_id: superadminId,
  });
  await repo.deletePost(id);

  if (post.status === "published") await purgePublishedBlogCache(post.slug);
  return true;
}

/**
 * Best-effort author notification. A failure here must never roll back a
 * completed publish, so it is logged rather than thrown.
 */
async function notifyAuthor(post, { type, title, message, action_url }) {
  if (!post.author_user_id) return;
  try {
    await notifyUser({
      user_id: post.author_user_id,
      workspaceId: post.author_workspace_id,
      type,
      title,
      message,
      action_url,
      source_key: `blog:${post.id}:${type}`,
      metadata: { post_id: post.id, slug: post.slug },
      mirrorToChat: false,
      broadcastToSlack: false,
    });
  } catch (error) {
    console.warn("[blog] author notification failed:", error.message);
  }
}
