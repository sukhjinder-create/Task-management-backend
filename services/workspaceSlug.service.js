// services/workspaceSlug.service.js
//
// Turning a workspace name into a hostname label.
//
// A slug is not cosmetic: it becomes `<slug>.asystence.com`, is validated by the
// edge router on every request, and is baked into links people share. So the
// rules here are deliberately strict and the generated value is stable -- a slug
// that changes silently breaks every bookmark pointing at it.

import pool from "../db.js";
import { isReservedSlug, MIN_SLUG_LENGTH } from "../config/reservedSlugs.js";

// One DNS label: RFC 1123, lowercase. Must match SLUG_PATTERN in
// cloudflare-worker/worker.js and routes/publicWorkspace.routes.js, or the edge
// will 404 slugs the database happily accepted.
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_SLUG_LENGTH = 63;

// Leaves room for the "-2", "-17" disambiguation suffix without the result
// overflowing the DNS label limit.
const MAX_BASE_LENGTH = MAX_SLUG_LENGTH - 6;

/**
 * Best-effort transliteration of a display name into a DNS label.
 *
 * Unicode is decomposed so accented Latin keeps its base letter ("Café" ->
 * "cafe") rather than losing the character entirely. Anything still non-ASCII
 * is dropped, which can legitimately empty the string -- a workspace named
 * purely in a non-Latin script has no meaningful ASCII slug, and the caller
 * falls back rather than inventing one.
 */
export function slugify(name) {
  return String(name || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_BASE_LENGTH)
    .replace(/-+$/g, "");
}

/**
 * Validate a slug a human chose. Returns null when acceptable, else the reason.
 *
 * Kept separate from generation because the two have different contracts:
 * generation may quietly adjust its input, but a slug someone typed must be
 * accepted or rejected with an explanation, never silently rewritten.
 */
export function validateSlug(slug) {
  const value = String(slug || "").trim().toLowerCase();

  if (!value) return "Slug is required";
  if (value.length < MIN_SLUG_LENGTH) {
    return `Slug must be at least ${MIN_SLUG_LENGTH} characters`;
  }
  if (value.length > MAX_SLUG_LENGTH) {
    return `Slug must be at most ${MAX_SLUG_LENGTH} characters`;
  }
  if (!SLUG_PATTERN.test(value)) {
    return "Slug may contain only lowercase letters, numbers and hyphens, and must start and end with a letter or number";
  }
  if (isReservedSlug(value)) {
    return "That slug is reserved";
  }
  // Rejected because xn-- is the IDNA ACE prefix: allowing it would let a
  // tenant claim a hostname that renders as arbitrary Unicode in a browser.
  if (value.startsWith("xn--")) {
    return "That slug is reserved";
  }
  return null;
}

/** Is this slug already taken by a workspace other than `excludeWorkspaceId`? */
async function slugIsTaken(client, slug, excludeWorkspaceId) {
  const { rows } = await client.query(
    `SELECT 1 FROM workspaces
      WHERE lower(slug) = $1
        AND ($2::uuid IS NULL OR id <> $2::uuid)
      LIMIT 1`,
    [slug, excludeWorkspaceId || null]
  );
  return rows.length > 0;
}

/**
 * Derive a unique, routable slug for a workspace name.
 *
 * Collisions are resolved with an incrementing suffix rather than a random one
 * so the result is predictable and readable: the second "Acme" becomes
 * "acme-2", not "acme-f3a9". The counter is bounded; past that we fall back to
 * a random suffix rather than scanning forever, which only happens on absurd
 * collision counts.
 *
 * Pass an existing `client` to run inside a caller's transaction -- important
 * on the creation path, where the uniqueness check and the insert must not be
 * separated by another request claiming the same slug.
 */
export async function generateUniqueSlug(name, { excludeWorkspaceId = null, client = null } = {}) {
  const db = client || pool;

  let base = slugify(name);

  // A name that yields nothing usable (non-Latin script, punctuation only) or
  // something reserved still needs a workspace to be creatable.
  if (base.length < MIN_SLUG_LENGTH || isReservedSlug(base) || base.startsWith("xn--")) {
    base = `workspace-${base}`.replace(/-+$/g, "").slice(0, MAX_BASE_LENGTH);
  }

  if (!(await slugIsTaken(db, base, excludeWorkspaceId))) return base;

  for (let suffix = 2; suffix <= 999; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!(await slugIsTaken(db, candidate, excludeWorkspaceId))) return candidate;
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = `${base}-${Math.random().toString(36).slice(2, 8)}`;
    if (!(await slugIsTaken(db, candidate, excludeWorkspaceId))) return candidate;
  }

  throw new Error(`Could not derive a unique slug for "${name}"`);
}

export { SLUG_PATTERN, MAX_SLUG_LENGTH };
