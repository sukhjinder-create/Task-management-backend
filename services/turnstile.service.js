const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstile(token, remoteIp, expectedAction = "signup") {
  const secret = String(process.env.TURNSTILE_SECRET_KEY || "").trim();
  if (!secret) return { skipped: true };
  if (!token) {
    throw Object.assign(new Error("Security check could not be completed. Please try again."), {
      statusCode: 400,
    });
  }

  let response;
  try {
    response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret,
        response: String(token),
        ...(remoteIp ? { remoteip: String(remoteIp) } : {}),
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw Object.assign(new Error("Security check is temporarily unavailable. Please try again."), {
      statusCode: 503,
    });
  }

  const result = await response.json().catch(() => ({}));
  const allowedHostnames = String(process.env.TURNSTILE_ALLOWED_HOSTNAMES || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const wrongAction = expectedAction && result.action !== expectedAction;
  const wrongHostname =
    allowedHostnames.length > 0 &&
    (!result.hostname || !allowedHostnames.includes(String(result.hostname).toLowerCase()));

  if (!response.ok || !result.success || wrongAction || wrongHostname) {
    throw Object.assign(new Error("Security check failed. Please try again."), { statusCode: 400 });
  }
  return result;
}
