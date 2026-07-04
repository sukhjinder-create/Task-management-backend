// ai-platform/keys/keyRef.js
//
// P8 — KeyRef indirection (Contract v2 §10). A KeyRef points at a secret in a
// manager; the secret VALUE is resolved only here (and thus only inside adapters,
// which import resolveApiKey). Secrets are never stored in a KeyRef, never
// returned in errors, never logged. Pure w.r.t. the process env; external secret
// managers are scaffolded (fail loudly) pending a dedicated integration.

export const SECRET_MANAGERS = Object.freeze([
  "env", "aws_secrets", "gcp_secret_manager", "vault", "kms",
]);

export function isSecretManager(m) {
  return SECRET_MANAGERS.includes(m);
}

/**
 * Resolve the secret value for a KeyRef.
 * @param {{manager?:string, ref:string, version?:string}} keyRef
 * @returns {string}  the secret value ("" if not found for env)
 */
export function resolveKeyRef(keyRef) {
  if (!keyRef || typeof keyRef !== "object" || !keyRef.ref) return "";
  const manager = keyRef.manager || "env";

  if (manager === "env") {
    const v = process.env[keyRef.ref];
    return v ? String(v).trim() : "";
  }

  // Scaffolding: external secret managers are wired by a dedicated integration in
  // a later phase. Fail loudly (never silently mis-resolve). The error message
  // deliberately does NOT include the ref value.
  const err = new Error(`Secret manager "${manager}" is not yet wired (Contract §10 scaffolding)`);
  err.code = "SECRET_MANAGER_NOT_IMPLEMENTED";
  throw err;
}
