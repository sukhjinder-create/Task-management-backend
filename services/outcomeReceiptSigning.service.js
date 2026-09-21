import crypto from "node:crypto";
import { decryptSecret, encryptSecret } from "../config/dataEncryption.js";

export const RECEIPT_SIGNATURE_ALGORITHM = "Ed25519";

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

export function canonicalReceiptJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function buildSignedReceiptDocument(receipt) {
  return {
    manifest: {
      receiptId: receipt.id,
      outcomeId: receipt.goal_id,
      version: Number(receipt.version),
      schemaVersion: Number(receipt.schema_version),
      generatedAt: new Date(receipt.generated_at).toISOString(),
      digestAlgorithm: "SHA-256",
      digestScope: "snapshot",
      sha256: receipt.sha256,
      signatureAlgorithm: receipt.signature_algorithm,
      keyId: receipt.signing_key_id,
      publicId: receipt.public_id,
    },
    snapshot: receipt.snapshot,
  };
}

export function createReceiptSignature(document, privateKeyPem) {
  return crypto.sign(null, Buffer.from(canonicalReceiptJson(document)), privateKeyPem).toString("base64url");
}

export function verifyReceiptSignature(document, signature, publicKeyPem) {
  try {
    return crypto.verify(
      null,
      Buffer.from(canonicalReceiptJson(document)),
      publicKeyPem,
      Buffer.from(String(signature || ""), "base64url")
    );
  } catch {
    return false;
  }
}

export async function getOrCreateReceiptSigningKey({ workspaceId, actorId, database }) {
  const existing = await database.query(
    `SELECT * FROM outcome_signing_keys
     WHERE workspace_id=$1 AND status='active'
     ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [workspaceId]
  );
  if (existing.rows[0]) return existing.rows[0];

  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  const inserted = await database.query(
    `INSERT INTO outcome_signing_keys
       (workspace_id, algorithm, public_key_pem, private_key_ciphertext, created_by)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING *`,
    [workspaceId, RECEIPT_SIGNATURE_ALGORITHM, publicKey, encryptSecret(privateKey), actorId]
  );
  return inserted.rows[0];
}

export function signReceiptDocument(document, key) {
  return createReceiptSignature(document, decryptSecret(key.private_key_ciphertext));
}
