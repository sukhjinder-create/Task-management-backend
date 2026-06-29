import { verifySuperadminAccessToken } from "../services/superadmin.service.js";

export default function requireSuperadmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing Super Admin token" });
  }

  try {
    const decoded = verifySuperadminAccessToken(auth.slice(7));
    if (
      !decoded ||
      decoded.role !== "superadmin" ||
      decoded.type !== "superadmin" ||
      !decoded.sub ||
      !decoded.sid
    ) {
      return res.status(401).json({ error: "Invalid Super Admin token" });
    }
    req.superadmin = {
      id: decoded.sub,
      email: decoded.email,
      role: "superadmin",
      sessionId: decoded.sid,
    };
    return next();
  } catch (error) {
    if (process.env.NODE_ENV !== "test") {
      console.warn("[superadmin auth] token rejected:", error.message);
    }
    return res.status(401).json({ error: "Invalid or expired Super Admin token" });
  }
}
