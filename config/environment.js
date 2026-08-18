import "dotenv/config";

const LOCAL_FRONTEND_URL = "http://localhost:5173";

function localBackendUrl() {
  return `http://localhost:${process.env.PORT || "3000"}`;
}

function clean(value) {
  return String(value || "").trim();
}

function cleanUrl(value) {
  return clean(value).replace(/\/+$/, "");
}

function firstValue(...values) {
  for (const value of values) {
    const cleaned = clean(value);
    if (cleaned) return cleaned;
  }
  return "";
}

function firstUrl(...values) {
  for (const value of values) {
    const cleaned = cleanUrl(value);
    if (cleaned) return cleaned;
  }
  return "";
}

function splitCsv(value) {
  return clean(value)
    .split(",")
    .map((item) => cleanUrl(item))
    .filter(Boolean);
}

export function envBool(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(clean(value).toLowerCase());
}

export function getAppEnv() {
  return firstValue(process.env.APP_ENV, process.env.NODE_ENV, "development").toLowerCase();
}

export function isProductionRuntime() {
  return getAppEnv() === "production";
}

export function isStagingRuntime() {
  return ["staging", "stage", "preview", "preprod"].includes(getAppEnv());
}

export function isLocalRuntime() {
  return !isProductionRuntime() && !isStagingRuntime();
}

export function getFrontendBaseUrl() {
  return firstUrl(process.env.FRONTEND_BASE_URL, process.env.FRONTEND_URL, LOCAL_FRONTEND_URL);
}

export function getBackendPublicUrl() {
  const explicit = firstUrl(process.env.API_PUBLIC_URL, process.env.BACKEND_PUBLIC_URL);
  if (explicit) return explicit;
  return localBackendUrl();
}

export function getGoogleCallbackUrl() {
  return firstUrl(
    process.env.GOOGLE_CALLBACK_URL,
    `${getBackendPublicUrl()}/auth/google/callback`
  );
}

export function getMobileAuthCallbackUrl() {
  return firstUrl(process.env.MOBILE_APP_AUTH_CALLBACK, "asystence://auth/callback");
}

export function getCorsAllowedOrigins() {
  const origins = new Set([
    getFrontendBaseUrl(),
    process.env.FRONTEND_URL,
    process.env.FRONTEND_BASE_URL,
    "https://asystence.com",
    "https://www.asystence.com",
    ...splitCsv(process.env.CORS_ALLOWED_ORIGINS),
  ].map(cleanUrl).filter(Boolean));

  if (!isProductionRuntime()) {
    [
      LOCAL_FRONTEND_URL,
      "http://localhost:5174",
      "http://localhost",
      "capacitor://localhost",
      "ionic://localhost",
    ].forEach((origin) => origins.add(origin));
  }

  return origins;
}

export function isAuthDevModeEnabled() {
  return envBool("AUTH_DEV_MODE", false) && !isProductionRuntime();
}

export function assertNotProductionRuntime(featureName) {
  if (isProductionRuntime()) {
    const error = new Error(`${featureName} is disabled in production`);
    error.statusCode = 404;
    throw error;
  }
}

/**
 * The apex domain workspace subdomains live under (`acme.<domain>`).
 *
 * Unset means the feature is off and no wildcard origin is trusted -- the
 * safe default, since a misconfigured value here would widen CORS.
 */
export function getWorkspaceDomain() {
  return String(process.env.WORKSPACE_DOMAIN || "").trim().toLowerCase().replace(/^\.+|\.+$/g, "");
}

// One DNS label. Deliberately the same shape the edge router and the slug
// service enforce, so an origin can only be trusted if it could actually be a
// workspace.
const WORKSPACE_ORIGIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Is `origin` a workspace subdomain of the configured workspace domain?
 *
 * Parsed as a URL rather than matched as a string on purpose. Suffix matching
 * is the classic way to get this wrong: `https://evil-asystence.com` and
 * `https://asystence.com.evil.com` both "end with" the domain under a naive
 * check, and both would be handed credentialed CORS access.
 *
 * Requires https, exactly one label below the apex (so `a.b.<domain>` is
 * refused), and no port -- none of which a real workspace URL ever has.
 */
export function isWorkspaceSubdomainOrigin(origin) {
  const domain = getWorkspaceDomain();
  if (!domain || !origin) return false;

  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  if (url.protocol !== "https:") return false;
  if (url.port) return false;

  const host = url.hostname.toLowerCase();
  if (!host.endsWith(`.${domain}`)) return false;

  const label = host.slice(0, -1 * (domain.length + 1));
  return WORKSPACE_ORIGIN_LABEL.test(label);
}

/**
 * Single authority for "may this origin talk to the API with credentials?".
 *
 * Both the HTTP layer and Socket.IO route through here; they used to disagree,
 * with sockets trusting exactly one origin while HTTP trusted a set.
 */
export function isAllowedCorsOrigin(origin) {
  if (!origin) return true;                       // same-origin / server-to-server
  if (getCorsAllowedOrigins().has(origin)) return true;
  if (isWorkspaceSubdomainOrigin(origin)) return true;
  return !isProductionRuntime();                  // dev stays permissive
}
