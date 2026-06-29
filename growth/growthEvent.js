import crypto from "node:crypto";

export const PUBLIC_GROWTH_EVENTS = new Set([
  "website.page_view",
  "website.session_started",
]);

export function deterministicGrowthEventId(identity) {
  const chars = crypto
    .createHash("sha256")
    .update(`asystence-growth:${String(identity)}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  chars[12] = "5";
  chars[16] = (8 + (Number.parseInt(chars[16], 16) % 4)).toString(16);
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const CATEGORY_BY_EVENT = {
  "website.page_view": "website",
  "website.session_started": "acquisition",
  "product.signup_completed": "acquisition",
  "product.login_attempt": "activation",
  "product.login_succeeded": "activation",
  "product.workspace_created": "activation",
  "product.project_created": "activation",
  "product.task_created": "activation",
  "product.team_created": "activation",
  "product.team_member_added": "activation",
  "product.chat_message_sent": "engagement",
  "product.huddle_created": "engagement",
  "product.ai_used": "engagement",
  "product.attendance_signed_in": "engagement",
  "product.attendance_signed_out": "engagement",
  "product.feature_used": "engagement",
  "product.activation_reached": "activation",
};

const SAFE_PROPERTY_KEYS = new Set([
  "feature_name",
  "method",
  "outcome",
  "status_code",
  "route_template",
  "screen_width",
  "screen_height",
  "viewport_width",
  "viewport_height",
  "is_returning_session",
  "provider",
]);

function cleanString(value, max = 255) {
  if (value === undefined || value === null) return null;
  const cleaned = String(value).trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

function cleanId(value) {
  const cleaned = cleanString(value, 80);
  return cleaned && /^[A-Za-z0-9_.:-]+$/.test(cleaned) ? cleaned : null;
}

function cleanUuid(value) {
  const cleaned = cleanString(value, 40);
  return cleaned && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cleaned)
    ? cleaned
    : null;
}

function cleanPath(value) {
  const path = cleanString(value, 1000);
  if (!path) return null;
  try {
    const parsed = new URL(path, "https://telemetry.invalid");
    return parsed.pathname.slice(0, 500) || "/";
  } catch {
    return path.split(/[?#]/)[0].slice(0, 500) || "/";
  }
}

function cleanProperties(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!SAFE_PROPERTY_KEYS.has(key)) continue;
    if (typeof raw === "boolean") result[key] = raw;
    else if (typeof raw === "number" && Number.isFinite(raw)) result[key] = raw;
    else if (typeof raw === "string") result[key] = raw.slice(0, 160);
  }
  return result;
}

function safeOccurredAt(value) {
  const parsed = value ? new Date(value) : new Date();
  const now = Date.now();
  if (!Number.isFinite(parsed.getTime()) || Math.abs(parsed.getTime() - now) > 86_400_000) {
    return new Date().toISOString();
  }
  return parsed.toISOString();
}

export function detectDevice(userAgent = "") {
  const ua = String(userAgent).toLowerCase();
  if (/ipad|tablet|kindle|silk/.test(ua)) return "tablet";
  if (/mobi|iphone|android/.test(ua)) return "mobile";
  return "desktop";
}

export function detectBrowser(userAgent = "") {
  const ua = String(userAgent);
  if (/Edg\//.test(ua)) return "Edge";
  if (/OPR\//.test(ua)) return "Opera";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Chrome\//.test(ua) || /CriOS\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return "Other";
}

export function classifyTrafficSource({ utmSource, utmMedium, referrerHost }) {
  if (utmSource) return cleanString(utmSource, 80);
  const medium = String(utmMedium || "").toLowerCase();
  if (medium.includes("email")) return "email";
  if (medium.includes("paid") || medium.includes("cpc") || medium.includes("ppc")) return "paid";
  const host = String(referrerHost || "").toLowerCase();
  if (!host) return "direct";
  if (/google|bing|yahoo|duckduckgo/.test(host)) return "organic_search";
  if (/linkedin|facebook|instagram|twitter|x\.com|reddit/.test(host)) return "social";
  return "referral";
}

export function requestGrowthContext(req) {
  const userAgent = req.headers["user-agent"] || "";
  const country =
    req.headers["cf-ipcountry"] ||
    req.headers["x-vercel-ip-country"] ||
    req.headers["x-country-code"] ||
    null;
  return {
    actorUserId: req.user?.id || null,
    workspaceId: req.user?.workspaceId || req.user?.workspace_id || req.workspaceId || null,
    anonymousId: cleanId(req.headers["x-growth-anonymous-id"]),
    sessionId: cleanId(req.headers["x-growth-session-id"]),
    deviceType: detectDevice(userAgent),
    browser: detectBrowser(userAgent),
    countryCode: cleanString(country, 8)?.toUpperCase() || null,
  };
}

export function normalizeGrowthEvent(input, { publicEvent = false } = {}) {
  const eventName = cleanString(input?.eventName, 120);
  if (!eventName || !CATEGORY_BY_EVENT[eventName]) throw new Error("Unsupported growth event");
  if (publicEvent && !PUBLIC_GROWTH_EVENTS.has(eventName)) throw new Error("Event is not accepted from public clients");

  const properties = cleanProperties(input.properties);
  const referrerHost = cleanString(input.referrerHost, 255)?.toLowerCase() || null;
  const utmSource = cleanString(input.utmSource, 160);
  const utmMedium = cleanString(input.utmMedium, 160);

  return {
    id: cleanUuid(input.id) || crypto.randomUUID(),
    eventName,
    category: CATEGORY_BY_EVENT[eventName],
    source: publicEvent ? "web" : cleanString(input.source, 32) || "server",
    actorUserId: cleanUuid(input.actorUserId),
    workspaceId: cleanString(input.workspaceId, 80),
    anonymousId: cleanId(input.anonymousId),
    sessionId: cleanId(input.sessionId),
    entityType: cleanString(input.entityType, 80),
    entityId: cleanString(input.entityId, 160),
    pagePath: cleanPath(input.pagePath),
    landingPage: cleanPath(input.landingPage),
    referrerHost,
    trafficSource: cleanString(input.trafficSource, 80) || classifyTrafficSource({ utmSource, utmMedium, referrerHost }),
    utmSource,
    utmMedium,
    utmCampaign: cleanString(input.utmCampaign, 160),
    deviceType: cleanString(input.deviceType, 32),
    browser: cleanString(input.browser, 64),
    countryCode: cleanString(input.countryCode, 8)?.toUpperCase() || null,
    properties,
    occurredAt: safeOccurredAt(input.occurredAt),
  };
}
