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
