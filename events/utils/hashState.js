import crypto from "crypto";

export function hashIntegrationState(obj) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(obj))
    .digest("hex");
}