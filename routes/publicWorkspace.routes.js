// routes/publicWorkspace.routes.js
//
// Unauthenticated workspace-slug resolution for the edge subdomain router.
//
// Why this exists: `*.asystence.com` is a wildcard DNS record fronted by a
// Cloudflare Worker. Without a way to tell a real workspace slug from a made-up
// one, the Worker served a full 200 app shell for *every* subdomain anyone
// asked for — so a single bot enumerating subdomains pulled the HTML plus a
// dozen hashed asset chunks per guess, all billed as Worker requests. This
// endpoint gives the Worker a cheap authoritative answer so it can 404 unknown
// slugs before any of that fan-out happens.
//
// Exposure: the response says only whether a slug is routable and whether it is
// suspended. That is strictly less than the subdomain already leaked by
// answering 200, and it carries no workspace contents, ids, or member data.

import express from "express";
import { findPublicWorkspaceBySlug } from "../repositories/workspace.repository.js";

const router = express.Router();

// Mirrors the slug shape the edge router accepts. Kept in sync with
// SLUG_PATTERN in cloudflare-worker/worker.js.
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// Cached at the edge so real traffic costs one origin hit per slug per window.
// Misses are cached far longer: unknown slugs are overwhelmingly enumeration
// noise, and a newly created workspace is a known slug, not an unknown one.
const HIT_CACHE_SECONDS = 300;
const MISS_CACHE_SECONDS = 3600;

/**
 * Is this string shaped like a workspace slug (a single DNS label)?
 *
 * Rejecting on shape keeps enumeration traffic off the database entirely.
 */
export function isRoutableSlugShape(slug) {
  return SLUG_PATTERN.test(String(slug || ""));
}

/**
 * Turn a slug lookup into the response the edge should cache.
 *
 * Suspended workspaces stay routable: the app renders its own suspension
 * messaging, which is a better answer than a bare edge 404.
 */
export function workspaceRoutingDecision(workspace) {
  if (!workspace) {
    return {
      status: 404,
      cacheSeconds: MISS_CACHE_SECONDS,
      body: { error: "Unknown workspace" },
    };
  }

  return {
    status: 200,
    cacheSeconds: HIT_CACHE_SECONDS,
    body: { slug: workspace.slug, status: workspace.status },
  };
}

/**
 * GET /public/workspaces/:slug/exists
 *
 * 200 { slug, status } — routable workspace
 * 404 { error }        — no such slug, or deleted
 */
router.get("/:slug/exists", async (req, res) => {
  const slug = String(req.params.slug || "").trim().toLowerCase();

  const decision = isRoutableSlugShape(slug)
    ? await resolve(slug, res)
    : workspaceRoutingDecision(null);

  if (!decision) return undefined; // resolve() already answered with a 5xx

  res.set("Cache-Control", `public, max-age=60, s-maxage=${decision.cacheSeconds}`);
  return res.status(decision.status).json(decision.body);
});

async function resolve(slug, res) {
  try {
    return workspaceRoutingDecision(await findPublicWorkspaceBySlug(slug));
  } catch (err) {
    console.error("[public.workspaces.exists] error:", err?.message || err);
    // Never cache an origin failure — the edge fails open on 5xx and we want it
    // re-checking as soon as the database is healthy again.
    res.set("Cache-Control", "no-store");
    res.status(500).json({ error: "Lookup failed" });
    return null;
  }
}

export default router;
