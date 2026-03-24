export function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  let ip = null;

  if (typeof forwarded === "string" && forwarded.trim()) {
    ip = forwarded.split(",")[0].trim();
  } else {
    ip =
      req.ip ||
      req.socket?.remoteAddress ||
      req.connection?.remoteAddress ||
      null;
  }

  if (!ip) return null;
  if (ip === "::1") return "127.0.0.1";
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  return ip;
}

export function getUserAgent(req) {
  return req.get("user-agent") || req.headers["user-agent"] || null;
}

export function getRequestAuditContext(req, extra = {}) {
  return {
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req),
    metadata: {
      route: req.originalUrl,
      method: req.method,
      ...extra,
    },
  };
}
