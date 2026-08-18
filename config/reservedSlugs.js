// config/reservedSlugs.js
//
// Labels that must never become a workspace slug.
//
// A workspace slug becomes a real hostname (`<slug>.asystence.com`), so a slug
// that collides with infrastructure is not a naming annoyance -- it is an
// outage. A workspace called "API" slugging to `api` would put a tenant on the
// backend's hostname; `app` would shadow the application itself. Both have a
// precedent: routing a backend subdomain to the frontend has already taken this
// product down once.
//
// SYNC: cloudflare-worker/worker.js keeps its own DEFAULT_RESERVED list, because
// the edge must be able to answer without consulting the database. The two must
// agree. This list is the superset and the source of truth; the Worker's list
// only needs the hostnames it actually serves.

/** Hostnames that are, or could become, real infrastructure on the zone. */
const INFRASTRUCTURE = [
  "api", "api-tunnel", "app", "www", "admin", "cdn", "static", "assets",
  "mail", "smtp", "imap", "pop", "ftp", "ns", "ns1", "ns2", "mx",
  "webhook", "webhooks", "socket", "ws", "wss", "livekit", "turn", "stun",
  "staging", "stage", "dev", "test", "qa", "preview", "sandbox", "demo",
  "internal", "private", "vpn", "proxy", "gateway", "edge", "origin",
];

/** Product surfaces we may want to claim later, or that would mislead users. */
const PRODUCT = [
  "auth", "login", "logout", "signup", "register", "account", "accounts",
  "billing", "payments", "checkout", "pricing", "plans", "invoice", "invoices",
  "support", "help", "docs", "documentation", "status", "blog", "about",
  "security", "legal", "privacy", "terms", "careers", "press", "contact",
  "superadmin", "system", "root", "official", "asystence",
];

/**
 * Single-letter and very short labels are reserved so they stay available for
 * future routing (short links, regional shards) rather than being claimed by
 * whichever tenant signs up first.
 */
const MIN_SLUG_LENGTH = 3;

const RESERVED = new Set([...INFRASTRUCTURE, ...PRODUCT]);

export { MIN_SLUG_LENGTH };

/** Is this label reserved (case-insensitive)? */
export function isReservedSlug(slug) {
  return RESERVED.has(String(slug || "").trim().toLowerCase());
}

/** Full reserved set, for tests and for auditing against the Worker's list. */
export function reservedSlugs() {
  return new Set(RESERVED);
}
