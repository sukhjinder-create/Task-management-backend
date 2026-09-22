import { isAllowedCorsOrigin, isProductionRuntime } from "../config/environment.js";

const COOKIE_PREFIX = isProductionRuntime() ? "__Host-" : "";
const ACCESS_COOKIE = `${COOKIE_PREFIX}asystence_access`;
const REFRESH_COOKIE = `${COOKIE_PREFIX}asystence_refresh`;
const MFA_COOKIE = `${COOKIE_PREFIX}asystence_mfa`;

const cookieOptions = (maxAge) => ({
  httpOnly: true,
  secure: isProductionRuntime(),
  sameSite: "strict",
  priority: "high",
  path: "/",
  ...(maxAge ? { maxAge } : {}),
});

export function readCookie(req, name) {
  const raw = String(req?.headers?.cookie || "");
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function isBrowserSessionRequest(req) {
  const origin = req?.headers?.origin;
  return req?.headers?.["x-auth-mode"] === "cookie" && !!origin && isAllowedCorsOrigin(origin);
}

export function accessTokenFromCookie(req) {
  return readCookie(req, ACCESS_COOKIE);
}

export function refreshTokenFromCookie(req) {
  return readCookie(req, REFRESH_COOKIE);
}

export function mfaTokenFromCookie(req) {
  return readCookie(req, MFA_COOKIE);
}

export function setBrowserSession(res, { token, refreshToken }) {
  if (token) res.cookie(ACCESS_COOKIE, token, cookieOptions(60 * 60_000));
  if (refreshToken) res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions(7 * 24 * 60 * 60_000));
  res.clearCookie(MFA_COOKIE, cookieOptions());
}

export function setBrowserMfaSession(res, token) {
  if (token) res.cookie(MFA_COOKIE, token, cookieOptions(5 * 60_000));
}

export function clearBrowserSession(res) {
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, MFA_COOKIE]) {
    res.clearCookie(name, cookieOptions());
  }
}

export function browserSafeAuthPayload(req, res, data) {
  if (!isBrowserSessionRequest(req)) return data;

  if (data?.mfa_required) setBrowserMfaSession(res, data.mfa_session_token);
  else setBrowserSession(res, data || {});

  const {
    token: _token,
    refreshToken: _refreshToken,
    mfa_session_token: _mfaToken,
    ...safe
  } = data || {};
  return safe;
}
